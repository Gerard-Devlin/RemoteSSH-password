import { WINDOWS_OPENSSH_PROFILES } from './compatibility.generated';

export interface WindowsOpenSSHProfile {
  readonly id: string;
  readonly displayVersion: string;
  readonly versionMarker: string;
  readonly sha256: string;
  readonly logVerbose: string;
  readonly archive?: {
    readonly url: string;
    readonly sha256: string;
  };
}

export const WINDOWS_SSH_PROFILES: readonly WindowsOpenSSHProfile[] =
  WINDOWS_OPENSSH_PROFILES;

export function windowsSSHProfile(
  sha256: string,
  versionLabel: string,
): WindowsOpenSSHProfile | undefined {
  return WINDOWS_SSH_PROFILES.find(
    (profile) =>
      profile.sha256 === sha256 && versionLabel.includes(profile.versionMarker),
  );
}

export function windowsSSHProfileById(
  id: string,
): WindowsOpenSSHProfile | undefined {
  return WINDOWS_SSH_PROFILES.find((profile) => profile.id === id);
}

// Kept for scripts and stored-state migrations that predate named profiles.
export const TESTED_SSH_SHA256 =
  '98d447730047f5df91373e852d057928a921c3d1e89938700ab656ba84b19dc8';
