/** ProvenFlow's version: in SARIF output, the MCP server's info and each review comment. Kept equal to package.json (a test checks it). */
export const PROVENFLOW_VERSION = '0.2.0';

/** Whether two versions share their major and minor numbers (0.2.0 and 0.2.3 do; 0.1.0 and 0.2.0, or an unknown version, do not). */
export function sameMinor(a: string | undefined, b: string | undefined): boolean {
    const minor = (v: string | undefined) => /^v?(\d+)\.(\d+)\./.exec(v ?? '')?.slice(1, 3).join('.');
    const left = minor(a);
    return left !== undefined && left === minor(b);
}
