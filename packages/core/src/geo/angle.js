//@ts-check

// Degree↔radian conversion factors shared by every geo module that
// trades between RFC 7946's decimal degrees and the radians the
// trigonometry needs. Internal to the kernel: the barrel does not
// re-export them, because callers hold degrees end to end.

/** Radians per degree — multiply degrees by this to get radians. */
export const DEG = Math.PI / 180;

/** Degrees per radian — multiply radians by this to get degrees. */
export const RAD = 180 / Math.PI;
