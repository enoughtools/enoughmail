interface NativeConnection {
  version: 1;
  deploymentHost: string;
  platform?: 'macOS' | 'iOS';
  perform(action: 'signOut' | 'changeDeployment'): boolean;
}

/** The installed shell supplies this bridge only to its active Mail document. */
export function nativeConnection(): NativeConnection | null {
  const value = (window as Window & { enoughMailConnection?: NativeConnection }).enoughMailConnection;
  return value?.version === 1 && value.deploymentHost === window.location.hostname && typeof value.perform === 'function' ? value : null;
}
