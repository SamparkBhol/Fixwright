// The four simulated surfaces. Views get the screen as
// containerDimensions plus the custom hostContext key 'dev.fixwright/deviceClass'.

export type DeviceClass = 'large' | 'small' | 'phone' | 'voice';
export type Theme = 'dark' | 'light';

export interface DeviceSpec {
  id: DeviceClass;
  label: string;
  detail: string;
  /** The device's screen in CSS pixels, null for the speaker. */
  screen: { width: number; height: number } | null;
  /** What the view may use: fixed on displays, a width with a height cap on the phone. */
  container: { width: number; height: number } | { width: number; maxHeight: number } | null;
  platform: 'web' | 'mobile';
}

export const DEVICES: Readonly<Record<DeviceClass, DeviceSpec>> = {
  large: { id: 'large', label: 'Large display', detail: '1280 × 800', screen: { width: 1280, height: 800 }, container: { width: 1280, height: 800 }, platform: 'web' },
  small: { id: 'small', label: 'Small display', detail: '960 × 480', screen: { width: 960, height: 480 }, container: { width: 960, height: 480 }, platform: 'web' },
  phone: { id: 'phone', label: 'Phone', detail: '390 × 844', screen: { width: 390, height: 844 }, container: { width: 358, maxHeight: 480 }, platform: 'mobile' },
  voice: { id: 'voice', label: 'Voice only speaker', detail: 'no screen', screen: null, container: null, platform: 'web' },
};

export const DEVICE_ORDER: readonly DeviceClass[] = ['large', 'small', 'phone', 'voice'];

export const isDeviceClass = (v: unknown): v is DeviceClass => typeof v === 'string' && Object.hasOwn(DEVICES, v);

/** The household's time zone. The demo house (SimHome) lives in Los Angeles. */
export const HOUSE_TIME_ZONE = 'America/Los_Angeles';
