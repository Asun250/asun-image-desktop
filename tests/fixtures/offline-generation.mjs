// UI-only tests must not consult a real API credential, even if one is installed.
export function offlineGeneration() {
  const service = () => ({token: 'offline-ui-fixture',
    status: async () => ({configured: false, authenticated: false, token: 'offline-ui-fixture', models: [], message: 'Generation is disabled in this UI test.'}),
    dispose() {},
  });
  return {sheets: service(), images: service()};
}
