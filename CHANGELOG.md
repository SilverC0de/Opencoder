# Changelog

All notable changes to the Opencoder UI extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-05-29

## [0.1.0] - 2026-05-29

### Added
- Initial release of Opencoder UI extension
- VS Code sidebar view for OpenCode session management
- Session creation, listing, and navigation
- Settings panel for extension configuration
- Terminal integration for OpenCode CLI
- Diff viewer for file changes
- Real-time connection status monitoring
- Support for workspace-specific session filtering by project directory
- Desktop notifications for agent events and permissions
- Custom keybindings configuration
- Theme and UI customization options
- Auto-save functionality for session edits
- Release notes on extension updates
- Sound notifications for different event types
- Model visibility configuration
- Workspace permission auto-accept option
- Status actions in the titlebar and popover
- Prompt control markers and layout improvements
- LICENSE and README documentation

### Changed
- Renamed extension ID from "opencoder" to "opencoder-ui" for clarity and consistency
- Updated extension display name to "Opencoder — A Clean Opencode Interface"
- Updated extension description to "A clean and polished VS Code interface for OpenCode"
- Refreshed publisher branding and icon path for consistency
- Sidebar refreshes automatically after settings changes
- Prompt and control surfaces aligned with VS Code tab-active selection colors
- Prompt input caret color uses foreground color for better visibility
- Polished webview UI: Free badge, titlebar buttons, user message surfaces, tooltips, and session title styling
- Cached `acquireVsCodeApi` for improved webview performance

### Technical Details
- Built with TypeScript and VS Code Extension API
- esbuild for bundling and compilation
- Supports VS Code 1.96.0 and later
- Integrated with @opencode-ai/sdk for OpenCode session management
