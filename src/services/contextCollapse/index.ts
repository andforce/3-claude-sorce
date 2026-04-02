export function isContextCollapseEnabled(): boolean { return false }
export async function collapseContext(_messages: unknown[]): Promise<unknown[]> { return _messages as unknown[] }
