export type NativeBridge = { onmessage: ((event: {data: string}) => void) | null; postMessage(message: string): void };
export function createObdBridgeClient(bridge: NativeBridge, options?: {timeoutMs?: number}): {
  request(action: 'list' | 'scan', address?: string): Promise<unknown>; cancel(): void; dispose(): void;
};
