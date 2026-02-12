# Contributing to SelfWorld

Thank you for considering contributing to SelfWorld! This document provides guidelines and instructions for contributing to the project.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Testing](#testing)

---

## 🤝 Code of Conduct

This project adheres to a Code of Conduct that all contributors are expected to follow:

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Accept constructive criticism gracefully
- Focus on what's best for the community
- Show empathy towards other community members

---

## 🚀 Getting Started

1. **Fork the repository** to your own GitHub account
2. **Clone your fork** to your local machine:
   ```bash
   git clone https://github.com/YOUR_USERNAME/SelfWorld.git
   cd SelfWorld
   ```
3. **Add upstream remote** to keep your fork in sync:
   ```bash
   git remote add upstream https://github.com/ORIGINAL_OWNER/SelfWorld.git
   ```
4. **Install dependencies**:
   ```bash
   cd bot
   npm install
   ```
5. **Set up your environment** following the [README.md](README.md) instructions

---

## 💻 Development Workflow

### Creating a Feature Branch

Always create a new branch for your work:

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

Branch naming conventions:
- `feature/` - New features or enhancements
- `fix/` - Bug fixes
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Adding or updating tests

### Keeping Your Branch Updated

Regularly sync with the upstream repository:

```bash
git fetch upstream
git rebase upstream/main
```

---

## 📝 Coding Standards

### JavaScript Style Guide

- **Use ESLint**: Run `npm run lint` before committing
- **Use camelCase** for variables and functions
- **Use PascalCase** for classes
- **Use UPPER_SNAKE_CASE** for constants
- **Use meaningful names** that describe purpose

### File Organization

```javascript
// 1. Imports (grouped by type)
const { Client } = require('discord.js');
const MyService = require('./services/MyService');

// 2. Constants
const DEFAULT_TIMEOUT = 5000;

// 3. Class/Function definitions
class MyClass {
    // Private methods prefixed with #
    #privateMethod() {}

    // Public methods
    publicMethod() {}
}

// 4. Exports
module.exports = { MyClass };
```

### Comments

- **File-level comments**: Describe the file's purpose at the top
  ```javascript
  // Manages zone creation and deletion with automatic cleanup
  ```
- **Method comments**: Use JSDoc format for public methods
  ```javascript
  /**
   * Creates a new zone with channels and roles
   * @param {GuildMember} member - The zone owner
   * @param {string} guildId - The guild ID
   * @param {Object} config - Zone configuration
   * @returns {Promise<Object>} The created zone data
   */
  async createZone(member, guildId, config) {}
  ```
- **Inline comments**: Explain "why", not "what"
  ```javascript
  // Good: Check if below 10% to avoid false positives
  if (score < 0.1) {}

  // Bad: Check if score is less than 0.1
  if (score < 0.1) {}
  ```

### Error Handling

Always handle errors gracefully:

```javascript
// Use try-catch for async operations
try {
    await someAsyncOperation();
} catch (err) {
    logger.error({ err, context }, 'Operation failed');
    // Handle or rethrow as appropriate
}

// Use .catch() for promise chains
somePromise()
    .then(result => handleResult(result))
    .catch(err => logger.error({ err }, 'Promise failed'));
```

### Database Queries

- **Use parameterized queries** to prevent SQL injection
- **Handle errors** with .catch()
- **Use transactions** for multi-step operations

```javascript
// Good
const [rows] = await pool.query(
    'SELECT * FROM zones WHERE id=? AND guild_id=?',
    [zoneId, guildId]
).catch(err => {
    logger.error({ err }, 'Query failed');
    return [[]];
});

// Bad - SQL injection risk!
const [rows] = await pool.query(
    `SELECT * FROM zones WHERE id=${zoneId}`
);
```

---

## 📝 Commit Guidelines

### Commit Message Format

Follow the conventional commits format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**

```
feat(zones): add support for custom zone colors

Add configurable color option to zone creation with validation
for valid hex colors. Defaults to Discord's blurple.

Closes #123
```

```
fix(anon): prevent mention sanitization bypass

The @everyone sanitization was case-sensitive, allowing
@EvErYoNe to bypass. Changed to case-insensitive regex.

Fixes #456
```

### Atomic Commits

Make small, focused commits:
- Each commit should represent a single logical change
- Avoid mixing refactoring with feature additions
- Makes code review easier and git history cleaner

---

## 🔍 Pull Request Process

### Before Submitting

1. **Run linter**: `npm run lint` (and fix any issues)
2. **Test your changes**: Ensure your changes work as expected
3. **Update documentation**: Add/update relevant documentation
4. **Check for conflicts**: Rebase on latest upstream/main

### Creating a Pull Request

1. **Push your branch** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Open a Pull Request** on GitHub with:
   - **Clear title**: Summarize the change
   - **Description**: Explain what and why
   - **Testing**: Describe how you tested
   - **Screenshots**: If UI changes, include screenshots
   - **Related issues**: Link to related issues

### PR Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
How did you test these changes?

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] No new warnings generated
```

### Review Process

- Maintainers will review your PR within a few days
- Address any requested changes
- Once approved, a maintainer will merge your PR
- Celebrate! 🎉 You've contributed to SelfWorld!

---

## 🧪 Testing

### Manual Testing

Before submitting, test your changes:

1. **Start the bot**: `npm run dev`
2. **Test all affected features**: Try commands, check logs
3. **Test edge cases**: Empty inputs, invalid data, etc.
4. **Check error handling**: Verify errors are logged properly

### Test Checklist

For new features:
- [ ] Feature works as intended
- [ ] Error cases handled gracefully
- [ ] Logs provide useful information
- [ ] No memory leaks or resource issues
- [ ] Database transactions complete correctly
- [ ] Discord resources cleaned up properly

---

## 🐛 Reporting Bugs

When reporting bugs, please include:

- **Description**: Clear description of the bug
- **Steps to Reproduce**: Detailed steps to recreate
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happens
- **Environment**: Node version, OS, etc.
- **Logs**: Relevant log output (sanitize tokens!)
- **Screenshots**: If applicable

---

## 💡 Suggesting Features

Feature requests are welcome! Please include:

- **Use case**: Why is this needed?
- **Proposed solution**: How should it work?
- **Alternatives**: Other approaches you considered
- **Additional context**: Mockups, examples, etc.

---

## 📚 Additional Resources

- [Discord.js Guide](https://discordjs.guide/)
- [MySQL Documentation](https://dev.mysql.com/doc/)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)

---

## 🙏 Thank You!

Your contributions make SelfWorld better for everyone. Whether it's code, documentation, bug reports, or feature ideas - every contribution matters!

Happy coding! 🚀
