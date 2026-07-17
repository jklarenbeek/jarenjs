import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combines class names with tailwind-merge for proper Tailwind CSS class handling
 * @param {...string} inputs - Class names to combine
 * @returns {string} - Merged class names
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/**
 * Formats a number with proper locale
 * @param {number} num - Number to format
 * @returns {string} - Formatted number
 */
export function formatNumber(num) {
  return new Intl.NumberFormat().format(num);
}

/**
 * Formats a percentage value
 * @param {number} value - Value to format as percentage
 * @param {number} decimals - Number of decimal places
 * @returns {string} - Formatted percentage
 */
export function formatPercent(value, decimals = 1) {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Truncates text to a specified length
 * @param {string} text - Text to truncate
 * @param {number} length - Maximum length
 * @returns {string} - Truncated text
 */
export function truncate(text, length = 50) {
  if (text.length <= length) return text;
  return text.slice(0, length) + '...';
}

/**
 * Copies text to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} - Success status
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('Failed to copy:', err);
    return false;
  }
}

/**
 * Formats a nanoseconds-per-operation value the way the benchmark tools do
 * @param {number} ns - Nanoseconds per operation
 * @returns {string} - Formatted duration
 */
export function formatNs(ns) {
  if (ns == null) return 'n/a';
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(0)} ns`;
}

/**
 * Formats an operations-per-second rate derived from ns/op
 * @param {number} ns - Nanoseconds per operation
 * @returns {string} - Formatted rate
 */
export function formatOps(ns) {
  if (ns == null || ns <= 0) return '';
  const ops = 1e9 / ns;
  if (ops >= 1e6) return `${(ops / 1e6).toFixed(1)}M ops/s`;
  if (ops >= 1e3) return `${(ops / 1e3).toFixed(1)}k ops/s`;
  return `${ops.toFixed(0)} ops/s`;
}

/**
 * Formats a speed ratio ("how many times faster/slower")
 * @param {number} ratio
 * @returns {string}
 */
export function formatRatio(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  if (ratio >= 100) return `${Math.round(ratio)}x`;
  if (ratio >= 10) return `${ratio.toFixed(1)}x`;
  return `${ratio.toFixed(2)}x`;
}

/**
 * Formats a duration in milliseconds to a human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - Formatted duration
 */
export function formatDuration(ms) {
  if (ms === 0 || ms == null) return '0ms';
  if (ms < 0.001) return `${(ms * 1000000).toFixed(2)}μs`;
  if (ms < 1) return `${(ms * 1000).toFixed(2)}μs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}
