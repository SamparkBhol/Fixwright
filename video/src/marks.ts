// Names the video must not show or say (the rules' video clause bans third party trademarks without
// permission). Alexa and Alexa+ are the sponsor's own track names and are allowed. Standards are names of
// open technologies the product describes (Wi-Fi, Zigbee); they are counted and reported, not failed.

export const MARK_SOURCE =
  '\\b(Hue|Philips|Signify|IKEA|TRADFRI|TP-Link|Kasa|Tapo|Nanoleaf|Aqara|ecobee|Ecobee|Nest|Google|Reddit|Home Assistant|ntfy|Kokoro|Echo|Amazon|OpenAI|gpt-oss|GPT|Apple|HomeKit|Samsung|SmartThings|Eve|Verge)\\b';
export const STANDARD_SOURCE = '\\b(Zigbee2MQTT|Zigbee|Wi-Fi|Z-Wave|Bluetooth|Matter)\\b';

/** The rules want every submission material in English; these are the product's Hindi answer chips. */
export const NON_ENGLISH_SOURCE = '\\b(haan|nahi|nahin|jal raha|jala|theek)\\b';

export function findMarks(text: string): string[] {
  return [...new Set(text.match(new RegExp(MARK_SOURCE, 'g')) ?? [])];
}

export function findStandards(text: string): string[] {
  return [...new Set(text.match(new RegExp(STANDARD_SOURCE, 'g')) ?? [])];
}

export function findNonEnglish(text: string): string[] {
  return [...new Set(text.toLowerCase().match(new RegExp(NON_ENGLISH_SOURCE, 'g')) ?? [])];
}
