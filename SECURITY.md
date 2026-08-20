# Security Policy

## Supported versions

Only the latest released version of `pi-specs-kit` receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅        |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Report vulnerabilities privately by emailing
**giuseppe.trisciuoglio@gmail.com** with:

- a description of the issue and its impact;
- the minimal steps or proof of concept to reproduce it;
- the `pi-specs-kit` version and Node.js version involved.

You should receive an acknowledgement within **5 business days**. Please do not
disclose the issue publicly until a fix has been released and you have been
notified.

## Trust model

`pi-specs-kit` is a [pi](https://github.com/earendil-works/pi)
extension. Extensions run with the full permissions of the user that launches
pi and can execute arbitrary code (it spawns `pi` subprocesses and runs
configurable shell hooks). Treat it like any other tool that can run commands
on your machine:

- Install only from sources you trust.
- Review the `hooks` you configure in `specs-kit.yaml` — pre/post hooks run
  shell commands before/after phases.
- Review the `*_model` providers you configure; the loop drives external model
  APIs with your credentials.
- The loop persists state under `<spec>/_ralph_loop/`; make sure that path is
  covered by your normal repository hygiene (it is gitignored-friendly by
  convention).

## Hardening checklist for deployments

- Pin a specific version when installing (`pi install npm:pi-specs-kit@x.y.z`)
  rather than floating tags.
- Run `npm audit` in your consuming environment regularly.
- Scope the shell hooks to idempotent, side-effect-free commands.
