import { createHash, randomUUID } from 'node:crypto';
export interface Target {
  host: string;
  port: string;
  user: string;
}
export interface Reply {
  value?: string;
  remember?: boolean;
  source?: string;
  ticket?: string;
  revision?: string;
  canceled?: boolean;
}
export interface Message {
  type: string;
  id?: string;
  session?: string;
  target?: Target;
  fingerprint?: string;
  verified?: boolean;
  kind?: string;
  prompt?: string;
  failed?: boolean;
  method?: string;
  reply?: Reply;
}
export interface Secrets {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}
export interface UI {
  ask(
    target: Target,
    prompt: string,
    cacheable: boolean,
    failed: boolean,
    signal?: AbortSignal,
  ): Promise<Reply>;
  trust(target: Target, prompt: string, signal?: AbortSignal): Promise<Reply>;
  changed(target: Target): void;
  cancel(session: string): void;
}
export interface RecordValue {
  target: Target;
  fingerprint: string;
  password: string;
  ticket: string;
  revision?: string;
  updated: string;
}
interface Session {
  target: Target;
  automatic: boolean;
  candidate?: Reply;
  fingerprint?: string;
  ended: boolean;
  abort: AbortController;
}
export function validTarget(t: Target | undefined): t is Target {
  return (
    !!t &&
    typeof t.host === 'string' &&
    typeof t.user === 'string' &&
    typeof t.port === 'string' &&
    !!t.host &&
    !!t.user &&
    t.host.length < 1024 &&
    t.user.length < 1024 &&
    !/[\r\n\x00]/.test(t.host + t.user) &&
    /^\d+$/.test(t.port) &&
    +t.port > 0 &&
    +t.port < 65536
  );
}
export function keyFor(t: Target): string {
  if (!validTarget(t)) throw new Error('Invalid target');
  return (
    'credential.v1.' +
    createHash('sha256')
      .update(JSON.stringify([t.host.toLowerCase(), String(+t.port), t.user]))
      .digest('hex')
  );
}
export const revocationKey = (key: string) => 'revocation.v1.' + key;
export const validFingerprint = (s?: string): s is string =>
  !!s && /^SHA256:[A-Za-z0-9+/]{43}$/.test(s);
const validPassword = (s?: string): s is string =>
  typeof s === 'string' &&
  s.length > 0 &&
  Buffer.byteLength(s, 'utf8') <= 8192 &&
  !/[\x00\r\n]/.test(s);
export class CredentialCore {
  private sessions = new Map<string, Session>();
  private pending = new Map<
    string,
    { promise: Promise<Reply>; abort: AbortController; users: Set<Session> }
  >();
  private generation = 0;
  constructor(
    private secrets: Secrets,
    private ui: UI,
    private index: (
      key: string,
      record?: Omit<RecordValue, 'password'>,
    ) => Promise<void>,
  ) {}
  async read(t: Target): Promise<RecordValue | undefined> {
    const raw = await this.secrets.get(keyFor(t));
    if (!raw) return;
    try {
      const r = JSON.parse(raw) as RecordValue;
      if (
        validTarget(r.target) &&
        keyFor(r.target) === keyFor(t) &&
        validFingerprint(r.fingerprint) &&
        validPassword(r.password) &&
        typeof r.ticket === 'string' &&
        (r.revision ?? '') ===
          ((await this.secrets.get(revocationKey(keyFor(t)))) ?? '')
      )
        return r;
    } catch {}
  }
  invalidate(key: string) {
    this.generation++;
    for (const s of this.sessions.values())
      if (keyFor(s.target) === key) {
        s.candidate = undefined;
        this.release(s);
      }
  }
  async forget(t: Target) {
    this.invalidate(keyFor(t));
    await this.secrets.store(revocationKey(keyFor(t)), randomUUID());
    await this.secrets.delete(keyFor(t));
    await this.index(keyFor(t));
  }
  clear() {
    this.generation++;
    for (const [id, s] of this.sessions) {
      s.ended = true;
      s.abort.abort();
      this.release(s);
      this.ui.cancel(id);
    }
    this.sessions.clear();
    this.pending.clear();
  }
  private async reject(s: Session) {
    const r = await this.read(s.target);
    if (s.candidate?.ticket && r?.ticket === s.candidate.ticket) {
      await this.secrets.delete(keyFor(s.target));
      await this.index(keyFor(s.target));
    }
    s.candidate = undefined;
  }
  async handle(m: Message): Promise<Reply> {
    const id = m.session;
    if (!id) return { canceled: true };
    if (m.type === 'open') {
      if (
        this.sessions.has(id) ||
        !validTarget(m.target) ||
        this.sessions.size >= 128
      )
        return { canceled: true };
      this.sessions.set(id, {
        target: m.target,
        automatic: false,
        ended: false,
        abort: new AbortController(),
      });
      return {};
    }
    const s = this.sessions.get(id);
    if (!s || s.ended) return { canceled: true };
    if (m.type === 'end') {
      s.ended = true;
      s.abort.abort();
      this.release(s);
      s.candidate = undefined;
      this.sessions.delete(id);
      this.ui.cancel(id);
      return {};
    }
    if (m.type === 'rejected') {
      await this.reject(s);
      return {};
    }
    if (m.type === 'success') {
      const candidate = s.candidate;
      s.candidate = undefined;
      if (
        m.method === 'password' &&
        candidate?.remember &&
        validPassword(candidate.value) &&
        validFingerprint(s.fingerprint)
      ) {
        if (
          (candidate.revision ?? '') !==
            ((await this.secrets.get(revocationKey(keyFor(s.target)))) ?? '') ||
          s.ended
        )
          return { canceled: true };
        const record: RecordValue = {
          target: s.target,
          fingerprint: s.fingerprint,
          password: candidate.value,
          ticket: candidate.ticket!,
          revision: candidate.revision ?? '',
          updated: new Date().toISOString(),
        };
        await this.secrets.store(keyFor(s.target), JSON.stringify(record));
        const { password, ...metadata } = record;
        await this.index(keyFor(s.target), metadata);
      }
      return {};
    }
    if (m.type !== 'ask' && m.type !== 'shared') return { canceled: true };
    const epoch = this.generation;
    if (m.failed) await this.reject(s);
    if (s.ended || epoch !== this.generation) return { canceled: true };
    if (m.kind === 'trust')
      return this.ui.trust(s.target, m.prompt ?? '', s.abort.signal);
    const cacheable =
      m.kind === 'password' &&
      m.verified === true &&
      validFingerprint(m.fingerprint);
    if (!cacheable) {
      s.candidate = undefined;
      return this.ui.ask(
        s.target,
        m.prompt ?? '',
        false,
        !!m.failed,
        s.abort.signal,
      );
    }
    s.fingerprint = m.fingerprint;
    const revision =
      (await this.secrets.get(revocationKey(keyFor(s.target)))) ?? '';
    const saved = await this.read(s.target);
    if (s.ended || epoch !== this.generation) return { canceled: true };
    const mismatch = !!saved && saved.fingerprint !== m.fingerprint;
    if (mismatch) this.ui.changed(s.target);
    if (m.type === 'shared') {
      const r = m.reply;
      if (
        !r ||
        r.canceled ||
        !validPassword(r.value) ||
        (r.revision ?? '') !== revision
      )
        return { canceled: true };
      if (r.source === 'saved' && (s.automatic || m.failed || mismatch))
        return this.prompt(s, m, cacheable);
      s.automatic ||= r.source === 'saved';
      s.candidate = r;
      return r;
    }
    if (saved && !s.automatic && !m.failed && !mismatch) {
      s.automatic = true;
      const r = {
        value: saved.password,
        remember: false,
        source: 'saved',
        ticket: saved.ticket,
        revision,
      };
      s.candidate = r;
      return r;
    }
    return this.prompt(s, m, cacheable);
  }
  private release(s: Session) {
    for (const [key, p] of this.pending) {
      p.users.delete(s);
      if (!p.users.size) {
        p.abort.abort();
        this.pending.delete(key);
      }
    }
  }
  private async prompt(
    s: Session,
    m: Message,
    cacheable: boolean,
  ): Promise<Reply> {
    const key = keyFor(s.target) + '|' + m.fingerprint + '|' + !!m.failed;
    const epoch = this.generation;
    const revision =
      (await this.secrets.get(revocationKey(keyFor(s.target)))) ?? '';
    if (s.ended || epoch !== this.generation) return { canceled: true };
    let pending = this.pending.get(key);
    if (!pending) {
      const abort = new AbortController();
      const promise = this.ui
        .ask(s.target, m.prompt ?? '', cacheable, !!m.failed, abort.signal)
        .then((r) => ({ ...r, source: 'input', ticket: randomUUID() }));
      pending = { promise, abort, users: new Set() };
      this.pending.set(key, pending);
      const own = pending;
      void promise
        .finally(() => {
          if (this.pending.get(key) === own) this.pending.delete(key);
        })
        .catch(() => {});
    }
    pending.users.add(s);
    const r = await pending.promise;
    if (
      s.ended ||
      epoch !== this.generation ||
      r.canceled ||
      !validPassword(r.value)
    )
      return { canceled: true };
    if (
      revision !==
        ((await this.secrets.get(revocationKey(keyFor(s.target)))) ?? '') ||
      s.ended ||
      epoch !== this.generation
    )
      return { canceled: true };
    s.candidate = { ...r, revision };
    return s.candidate;
  }
}
