// Runtime configuration. Defaults come from the build (scripts/build.ts defines); query parameters
// override them so one build can point at the live Worker, wrangler dev or the mock server:
//   ?server=http://127.0.0.1:8713   base URL of the Fixwright server (MCP at <server>/mcp)
//   ?sandbox=http://127.0.0.1:8712/sandbox.html   the sandbox proxy page on its own origin
//   ?router=server   route utterances through POST <server>/assistant/route instead of the local router
//   ?device=phone&theme=light   initial device and theme
//   ?test=1   deterministic mode: no audio, no animations, the clock only moves when told
//   ?ha_devices=real   a linked Home Assistant with real devices (default: the test hub's demo devices)

import { isDeviceClass, type DeviceClass, type Theme } from './devices.ts';

declare const __SANDBOX_URL__: string;
declare const __SERVER_URL__: string;
declare const __HOST_VERSION__: string;

export interface HostConfig {
  serverUrl: string;
  mcpUrl: string;
  sandboxUrl: string;
  sandboxOrigin: string;
  routerMode: 'local' | 'server';
  device: DeviceClass;
  theme: Theme;
  testMode: boolean;
  version: string;
  /** The views' tag for a linked Home Assistant. The demo links a test hub whose devices are fixtures. */
  hubLabel: string;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

export function readConfig(loc: Pick<Location, 'search' | 'origin'>): HostConfig {
  const q = new URLSearchParams(loc.search);
  const serverUrl = trimSlash(q.get('server') || (typeof __SERVER_URL__ === 'string' && __SERVER_URL__) || loc.origin);
  const sandboxUrl = q.get('sandbox') || (typeof __SANDBOX_URL__ === 'string' && __SANDBOX_URL__) || 'http://127.0.0.1:8712/sandbox.html';
  const device = q.get('device');
  return {
    serverUrl,
    mcpUrl: `${serverUrl}/mcp`,
    sandboxUrl,
    sandboxOrigin: new URL(sandboxUrl, loc.origin).origin,
    routerMode: q.get('router') === 'server' ? 'server' : 'local',
    device: isDeviceClass(device) ? device : 'large',
    theme: q.get('theme') === 'light' ? 'light' : 'dark',
    testMode: q.get('test') === '1',
    version: typeof __HOST_VERSION__ === 'string' ? __HOST_VERSION__ : '0.0.0',
    hubLabel: q.get('ha_devices') === 'real' ? 'Real Home Assistant' : 'Real Home Assistant, demo devices',
  };
}
