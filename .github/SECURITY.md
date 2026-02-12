# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

We only provide security fixes for the latest release. We recommend always running the latest version.

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in SelfWorld, we appreciate your help in disclosing it responsibly.

### How to Report

1. **GitHub Security Advisories (preferred)**: Use [GitHub's private vulnerability reporting](https://github.com/[YOUR_GITHUB_USERNAME]/SelfWorld/security/advisories/new) to submit a report directly on the repository.

2. **Email**: Send a detailed report to **[YOUR_EMAIL]** with the subject line: `[SelfWorld Security] Brief description`.

### What to Include

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- The affected version(s)
- Any potential fixes or suggestions you may have

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your report within **48 hours**.
- **Assessment**: We will investigate and provide an initial assessment within **7 days**.
- **Resolution**: We aim to release a fix within **30 days** for confirmed vulnerabilities, depending on complexity.
- **Credit**: We will credit you in the release notes (unless you prefer to remain anonymous).

## Security Considerations for SelfWorld

Since SelfWorld is a Discord bot handling user data and anonymous messaging, we take the following areas especially seriously:

### Critical Areas

- **Bot token exposure**: Never commit `.env` files or tokens to the repository
- **SQL injection**: All database queries must use parameterized statements
- **Anonymous identity leaks**: The anonymous messaging system must never reveal user identities
- **Permission escalation**: Commands must validate Discord permissions properly
- **Webhook security**: Anonymous message webhooks must not be exploitable

### For Contributors

When contributing code, please ensure:

- Database queries use parameterized statements (`?` placeholders), never string concatenation
- User input is validated and sanitized before processing
- Discord permissions are checked before executing privileged operations
- No tokens, credentials, or sensitive data are committed
- Anonymous user identities cannot be leaked through error messages or logs

## Disclosure Policy

- We follow a **coordinated disclosure** approach
- We ask that you give us reasonable time to fix the issue before public disclosure
- We will work with you to determine an appropriate disclosure timeline
- We will not take legal action against researchers who follow this policy

Thank you for helping keep SelfWorld and its users safe.
