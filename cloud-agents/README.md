# Pi Cloud

Run Pi, its subagents, and Git worktrees on one Oracle A1 VM. Close the laptop and reattach to the same work with `pi --cloud`.

This directory is a standalone Pi package. It is not a second executable. Ordinary `pi` stays local.

## Install

From a checkout of this repository:

```sh
pi install ./cloud-agents
```

Once published the same package would install as `pi install npm:pi-cloud-agent`. `pi install` will not refresh an existing install; use `pi update`.

## Use

```sh
cd my-project
pi --cloud
pi --cloud --repo OWNER/REPO --branch main
```

| Input | Behavior |
| --- | --- |
| `pi` | Ordinary local Pi. Cloud does nothing. |
| `pi --cloud` | Infer `origin` and the current branch; attach the matching remote session. Several matches open a picker that includes **New session**. First use runs guided setup. |
| `--repo <owner/repo\|url>` | Explicit remote repository instead of local `origin`. Local files are never copied. Without `--branch`, the base is the current local branch when that checkout matches the repo, otherwise the remote default HEAD. `main` is never invented. |
| `--branch <name>` | Explicit base branch. Work happens on an isolated `pi/<session-id>` branch, never directly on `main`. |
| `/cloud` | Read-only status inside remote Pi: host, repo/path, branches, exact session, and whether commits are only local. Unknown state is shown as unknown, not idle. |

Detaching from tmux leaves remote Pi running. `pi --cloud` is the reattach path. Do not overload local `--resume` with a remote meaning.

## First-run setup

1. Browser-authenticate the OCI CLI profile **`PI_CLOUD`** (`security_token`). The CLI holds the token; this package does not read `~/.oci` secrets.
2. Show the account and home region. Adopt an existing approved A1 host when one matches.
3. Create a free-only A1 VM only after an eligibility report and explicit confirmation. `FREE_TIER` includes trial accounts and is not a blanket Always Free proof; eligibility is independently bounded. The confirm dialog names the verified platform image and OCID. Failed free allocation never becomes paid.
4. Pin the guest Ubuntu sshd host key from independently authenticated **cloud-init console-history** before any SSH command. Serial-console service keys are refused. If enrollment cannot be done safely, setup stays blocked and never uses `accept-new`.
5. Clone the remote git URL on the VM and start Pi in tmux. Local model credentials are not copied; sign in on the VM.

Interrupted setup resumes its verified step on the next `pi --cloud` instead of creating another VM.

## Live trial

You must do these on your machine. This package’s tests stay offline.

1. Install the [OCI CLI](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/cliconcepts.htm) and OpenSSH.
2. `pi install ./cloud-agents` from this repo.
3. From a **pushed** git checkout: `pi --cloud`.
4. Complete the `PI_CLOUD` browser login for your tenancy **home** region.
5. Confirm adopt or, only if eligible, confirm create. Review the planned writes.
6. If host-key enrollment blocks, capture cloud-init console history after first boot and re-run. Do not accept a changed host key.
7. If the VM is missing Node.js >= 22.19, git, tmux, or `pi`, install them **on the VM** from sources you trust, then re-run `pi --cloud`.
8. In the remote Pi session, log into your model provider there. Optionally install this package on the VM if you want `/cloud` status.

## Safety

- No `pi-cloud` binary, `.env` knobs, `--snapshot`, `--public`, or idle-stop flags.
- Temporary WAN SSH, when created, is the operator IPv4 `/32` only.
- SSH uses `StrictHostKeyChecking=yes` against a pinned known_hosts file.
- Unknown cost, host, or job state fails closed.
- OCI stop/reboot can interrupt processes even when disk sessions survive. In-flight resume is not promised.
