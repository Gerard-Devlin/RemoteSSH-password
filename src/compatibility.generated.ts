// Generated from native/windows-openssh.json. Do not edit directly.
export const WINDOWS_OPENSSH_PROFILES = [
  {
    id: 'system-9.5p2',
    displayVersion: 'Windows system OpenSSH 9.5p2',
    versionMarker: 'OpenSSH_for_Windows_9.5p2',
    sha256: '98d447730047f5df91373e852d057928a921c3d1e89938700ab656ba84b19dc8',
    logVerbose:
      '*:verify_host_key():*,*:check_host_key():*,*:ssh_userauth2():*,*:authmethod_get():*,*:userauth_passwd():*,*:input_userauth_info_req():2017*,*:input_userauth_failure():653*,*:ssh_packet_read_poll2():*,*:read_passphrase():*,*:warn_changed_key():*,*:ssh_connect_direct():*',
  },
  {
    id: 'openssh-9.5p1',
    displayVersion: 'Win32-OpenSSH 9.5p1',
    versionMarker: 'OpenSSH_for_Windows_9.5p1',
    sha256: 'e41e50a22dffeae8bb13bce4cb47b6c4aa0de4cdecbd62ef79d5046adc05a8b1',
    logVerbose:
      '*:verify_host_key():*,*:check_host_key():*,*:ssh_userauth2():*,*:authmethod_get():*,*:userauth_passwd():*,*:input_userauth_info_req():2004*,*:input_userauth_failure():645*,*:ssh_packet_read_poll2():*,*:read_passphrase():*,*:warn_changed_key():*,*:ssh_connect_direct():*',
    archive: {
      url: 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/v9.5.0.0p1-Beta/OpenSSH-Win64.zip',
      sha256:
        'bd48fe985d400402c278c485db20e6a82bc4c7f7d8e0ef5a81128f523096530c',
    },
  },
  {
    id: 'openssh-9.8p2',
    displayVersion: 'Win32-OpenSSH 9.8p2',
    versionMarker: 'OpenSSH_for_Windows_9.8p2',
    sha256: 'edb93b2139ee59fbee2b8dc0ba9f929d7ecda64d47d61eb1029de1413dff3224',
    logVerbose:
      '*:verify_host_key():*,*:check_host_key():*,*:ssh_userauth2():*,*:authmethod_get():*,*:userauth_passwd():*,*:input_userauth_info_req():2021*,*:input_userauth_failure():642*,*:ssh_packet_read_poll2():*,*:read_passphrase():*,*:warn_changed_key():*,*:ssh_connect_direct():*',
    archive: {
      url: 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/v9.8.3.0p2-Preview/OpenSSH-Win64.zip',
      sha256:
        '0ca131f3a78f404dc819a6336606caec0db1663a692ccc3af1e90232706ada54',
    },
  },
  {
    id: 'openssh-10.0p2',
    displayVersion: 'Win32-OpenSSH 10.0p2',
    versionMarker: 'OpenSSH_for_Windows_10.0p2',
    sha256: '6890c128c86cc2c38aad9fcb32a82b851ff3d38c714a1f656b8e445d7cd5e1c6',
    logVerbose:
      '*:verify_host_key():*,*:check_host_key():*,*:ssh_userauth2():*,*:authmethod_get():*,*:userauth_passwd():*,*:input_userauth_info_req():2021*,*:input_userauth_failure():642*,*:ssh_packet_read_poll2():*,*:read_passphrase():*,*:warn_changed_key():*,*:ssh_connect_direct():*',
    archive: {
      url: 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview/OpenSSH-Win64.zip',
      sha256:
        '23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5',
    },
  },
] as const;
