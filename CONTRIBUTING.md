# Contributing to What's Your NYC Stories?

Thanks for your interest in this project! It started as a class project at NYU ITP, and I'd love for it to keep growing as more people add to it.

## Ways to Contribute

- **Report bugs** — open an issue with steps to reproduce, what you expected, and what actually happened.
- **Suggest features** — open an issue describing the idea and why it would matter for the typographic-map experience.
- **Send a pull request** — bug fixes, performance improvements, mobile polish, accessibility, or new features.
- **Seed stories** — write into the live map at the deployed URL and tell your friends to do the same.

## Development Setup

1. Fork this repo and clone your fork.
2. Install dependencies: `npm install`
3. Run the dev server: `npm run dev` (auto-reloads on file changes)
4. Open http://localhost:5001 in two or more browser windows to test live sync.

## Pull Request Guidelines

- Create a feature branch off `main`: `git checkout -b your-feature-name`
- Keep PRs focused — one logical change per PR makes review easier.
- Match the existing code style (vanilla JS on the client, no framework, minimal dependencies).
- Test in at least two browser windows simultaneously to confirm real-time sync still works.
- If your change touches Pretext layout or zoom, screenshot or screen-record the before/after in the PR description.
- Update `README.md` or `PLAN.md` if you change behavior that's documented there.

## Commit Messages

Plain-English present tense is fine. Examples:

- `add pinch-zoom on mobile`
- `fix title overflow when a dot has 50+ stories`
- `cache pretext layout per zoom tier`

## Reporting Bugs

When opening a bug issue, please include:

- Browser + OS (e.g. Chrome 124 on macOS 14)
- Steps to reproduce
- What you expected to happen
- What actually happened (screenshots or recordings help a lot for visual bugs)
- Console errors if any

## Code of Conduct

By participating in this project you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md). Please be kind — this is a small, friendly project.

## Questions

Open an issue and tag it `question`, or reach out at summerhhwang@gmail.com.
