const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Share the reviewed network registry with the read-only CLI without copying addresses.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../../config'),
  path.resolve(__dirname, '../web/src'), path.resolve(__dirname, '../web/shared'),
  path.resolve(__dirname, '../web/server'), path.resolve(__dirname, '../dashboard'),
  // The shared purchase check in web/src/pilot.ts imports the SDK's assessment validator.
  path.resolve(__dirname, '../../packages/sdk/src')];
// Resolve shared domain modules against the native dependency graph, including React.
config.resolver.disableHierarchicalLookup = false;
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
const sharedRoots = ['../web/src', '../web/shared', '../web/server', '../dashboard', '../../packages/sdk/src'].map(p => path.resolve(__dirname, p) + path.sep);
config.resolver.resolveRequest = (context, name, platform) => {
  // Shared source uses the app's direct dependencies. A dependency's own nested
  // dependencies still resolve normally (notably viem's older noble versions).
  const shared = sharedRoots.some(root => context.originModulePath.startsWith(root));
  const bare = !name.startsWith('.') && !path.isAbsolute(name);
  return context.resolveRequest(shared && bare ? { ...context, originModulePath: path.join(__dirname, 'index.ts') } : context, name, platform);
};
module.exports = config;
