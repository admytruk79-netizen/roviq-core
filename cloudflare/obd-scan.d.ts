export type Scan = {scanId: string; observedAt: string; dtcResponse: string; pidResponses?: Record<string,string>};
export type ScanContext = {vehicleId: string; sourceId: string; enrollmentId: string; serviceCaseId: string};
export const READ_ONLY_COMMANDS: readonly string[];
export function allowedObdCommand(command: string): string;
export function decodeStoredDtcs(raw: string): string[];
export function decodePid(raw: string, pid: string): Record<string,unknown>;
export function createHealthEvent(context: ScanContext, scan: Scan): {dtcCodes: string[]; normalizedSignals: Record<string,unknown>};
export function uploadAndAnalyzeScan(input: {token: string; context: ScanContext; scan: Scan; apiBase: string}): Promise<{
  event: {id: string}; analysisPending: boolean; analysisState?: string; assessmentId?: string | null;
  analysis: {modelStatus: 'ai'|'fallback'; summary: string; possibleCauses: {cause: string; confirmed: false}[]; missingInformation: string[]; recommendedChecks: string[]} | null;
}>;
