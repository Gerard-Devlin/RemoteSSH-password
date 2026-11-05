import { Target, validFingerprint } from './core';

export interface HostIdentity {
  keyType: string;
  fingerprint: string;
}

// Presentation only: the displayed key must match the active SSH session's
// fingerprint. Unrecognized requests stay available as the original text.
export function parseHostIdentity(
  prompt: string,
  sessionFingerprint?: string,
): HostIdentity | undefined {
  if (!validFingerprint(sessionFingerprint) || prompt.length > 8192) return;
  const normalized = prompt.replace(/\r\n/g, '\n').trimEnd();
  if (
    !normalized.startsWith("The authenticity of host '") ||
    !normalized.endsWith(
      'Are you sure you want to continue connecting (yes/no/[fingerprint])?',
    )
  )
    return;
  const keys = [
    ...normalized.matchAll(
      /^([A-Z0-9][A-Z0-9@._+-]{0,31}) key fingerprint is[ \t]*(?:\n[ \t]*)?(SHA256:[A-Za-z0-9+/]{43})\.[ \t]*$/gm,
    ),
  ];
  const fingerprints = normalized.match(/SHA256:[A-Za-z0-9+/]{43}/g) ?? [];
  if (
    keys.length !== 1 ||
    keys[0][2] !== sessionFingerprint ||
    fingerprints.some((value) => value !== sessionFingerprint)
  )
    return;
  return { keyType: keys[0][1], fingerprint: sessionFingerprint };
}

export function serverAddress(target: Target): string {
  const host =
    target.host.includes(':') && !target.host.startsWith('[')
      ? '[' + target.host + ']'
      : target.host;
  return host + ':' + target.port;
}
