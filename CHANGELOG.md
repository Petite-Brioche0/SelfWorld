# Changelog

All notable changes to the SelfWorld Discord Bot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project documentation
- Comprehensive README with feature overview
- Contributing guidelines
- MIT License

---

## [0.1.0] - 2026-02-09

### Added
- Core zone management system
  - Zone creation with automatic channel/role setup
  - Zone deletion with comprehensive cleanup
  - Zone member management
  - Zone activity tracking
- Anonymous messaging system
  - Persistent anonymous identities per zone
  - Webhook-based message relaying
  - Audit logging for moderation
  - Mention sanitization
- Hub system for new members
  - Personalized welcome channels
  - Interactive panel-based navigation
  - Wizard-style onboarding
  - Staff announcement system
- Task scheduler
  - Lifecycle management for periodic tasks
  - Timeout protection
  - Concurrent execution prevention
  - Graceful shutdown support
- Temporary group system
  - Create temporary groups within zones
  - Automatic expiration
  - Custom permissions
- Activity monitoring
  - Normalized activity scoring
  - Low-activity alerts (< 10% threshold)
  - Daily activity tracking
- Database schema
  - MySQL with proper foreign keys
  - Cascading deletes
  - Normalized structure
- Structured logging with Pino
  - Pretty logs in development
  - JSON logs in production
- Rate limiting and spam protection
- Hot-reloadable commands and events

### Fixed
- Low-activity alerts now trigger below 10% threshold (not just zero)
- Zone deletion now cleans up 15+ database tables properly
- Mention sanitization prevents @everyone/@here bypass
- Task scheduler prevents concurrent executions
- Anonymous messages properly sanitized

### Changed
- Renamed "onboarding" terminology to "hub" throughout codebase
- Improved tag validation (max 5 tags, 50 chars each)
- Enhanced error handling across all services
- Improved comment formatting and clarity

### Security
- SQL injection prevention with parameterized queries
- Permission validation on all commands
- Webhook security for anonymous messages
- Audit logging for moderation

---

## Version History

- [0.1.0] - 2026-02-09 - Initial release

[Unreleased]: https://github.com/yourusername/SelfWorld/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yourusername/SelfWorld/releases/tag/v0.1.0
