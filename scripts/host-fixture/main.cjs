// Test-only extension. Never packaged. Runs in an isolated VS Code profile.
exports.activate = (context) => ({
  secrets: context.secrets,
  state: context.globalState,
});
