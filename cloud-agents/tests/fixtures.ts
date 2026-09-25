export const GUEST_SSH_HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPiCloudGuestSshdKeyFixture000001";

export const CLOUD_INIT_CONSOLE = `
Cloud-init v. 24.1 running
-----BEGIN SSH HOST KEY FINGERPRINTS-----
256 SHA256:abcd ubuntu@instance (ECDSA)
-----END SSH HOST KEY FINGERPRINTS-----
-----BEGIN SSH HOST KEY KEYS-----
ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC0fixture
${GUEST_SSH_HOST_KEY} ubuntu@instance
-----END SSH HOST KEY KEYS-----
ci-info: finished
`;
