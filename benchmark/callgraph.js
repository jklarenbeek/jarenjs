#!/usr/bin/env node

/**
 * JarenJS Call Graph Analysis Tool
 * 
 * Generates text-based call graphs using Node.js built-in --prof profiler.
 * Perfect for LLM analysis of hot paths and call chains.
 * 
 * Usage:
 *   node benchmark/callgraph.js '/ref.json'
 *   node benchmark/callgraph.js '/ref.json' --iterations 5000
 *   node benchmark/callgraph.js '/ref.json' --top-functions=20
 *   node benchmark/callgraph.js '/ref.json' --max-depth=10
 * 
 * Options:
 *   --iterations, -i N       Number of iterations (default: 1000)
 *   --top-functions N        Show top N hottest functions (default: 20)
 *   --max-depth N            Maximum call chain depth to display (default: 10)
 *   --filter <pattern>       Filter functions by pattern (default: jaren)
 *   --include-internals      Include Node.js internal functions
 *   --verbose, -v            Show detailed output
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const DEFAULT_ITERATIONS = 1000;
const WARMUP_ITERATIONS = 100;
const DEFAULT_TOP_FUNCTIONS = 20;
const DEFAULT_MAX_DEPTH = 10;

// Parse arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    targetFile: null,
    iterations: DEFAULT_ITERATIONS,
    topFunctions: DEFAULT_TOP_FUNCTIONS,
    maxDepth: DEFAULT_MAX_DEPTH,
    filter: 'jaren',
    includeInternals: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--iterations' || arg === '-i') {
      options.iterations = parseInt(args[++i], 10) || DEFAULT_ITERATIONS;
    } else if (arg.startsWith('--top-functions')) {
      const val = arg.includes('=') ? arg.split('=')[1] : args[++i];
      options.topFunctions = parseInt(val, 10) || DEFAULT_TOP_FUNCTIONS;
    } else if (arg.startsWith('--max-depth')) {
      const val = arg.includes('=') ? arg.split('=')[1] : args[++i];
      options.maxDepth = parseInt(val, 10) || DEFAULT_MAX_DEPTH;
    } else if (arg === '--filter') {
      options.filter = args[++i] || 'jaren';
    } else if (arg === '--include-internals') {
      options.includeInternals = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (!arg.startsWith('--') && !options.targetFile) {
      options.targetFile = arg;
    }
  }

  return options;
}

// Print help
function printHelp() {
  console.log(`Usage: node benchmark/callgraph.js <testfile.json> [options]`);
  console.log('');
  console.log('Options:');
  console.log('  --iterations, -i N       Number of iterations (default: 1000)');
  console.log('  --top-functions N        Show top N hottest functions (default: 20)');
  console.log('  --max-depth N            Maximum call chain depth (default: 10)');
  console.log('  --filter <pattern>       Filter functions by pattern (default: jaren)');
  console.log('  --include-internals      Include Node.js internal functions');
  console.log('  --verbose, -v            Show detailed output');
  console.log('  --help, -h               Show this help message');
  console.log('');
  console.log('Examples:');
  console.log(`  node benchmark/callgraph.js '/ref.json'`);
  console.log(`  node benchmark/callgraph.js '/ref.json' --iterations 5000`);
  console.log(`  node benchmark/callgraph.js '/type.json' --top-functions=30`);
  console.log(`  node benchmark/callgraph.js '/items.json' --max-depth=15`);
  process.exit(0);
}

// Generate profiling script
function generateProfilingScript(targetFile, iterations, warmupIterations) {
  return `
import { loadTestSuiteJson, loadRemoteJson } from './benchmark/loader.js';
import { TestRunner } from './benchmark/runner.js';
import * as jaren from './benchmark/adaptors/jaren.js';

const draft = 'draft7';
const targetFile = '${targetFile}';
const iterations = ${iterations};
const warmupIterations = ${warmupIterations};

async function runProfile() {
  const tests = await loadTestSuiteJson(draft);
  const remotes = await loadRemoteJson();
  
  TestRunner.initialize(draft, jaren);
  TestRunner.load(remotes);
  
  const fileKey = targetFile.startsWith('/') ? targetFile : '/' + targetFile;
  const suiteTests = tests[fileKey];
  
  if (!suiteTests) {
    console.error('Test file not found:', targetFile);
    process.exit(1);
  }
  
  // Warmup phase
  for (const test of suiteTests) {
    const runner = TestRunner.runTest(test);
  }
  
  // Profile phase - run multiple iterations
  for (let i = 0; i < iterations; i++) {
    for (const test of suiteTests) {
      const runner = TestRunner.runTest(test);
    }
  }
}

runProfile().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
`;
}

// Parse V8 profiler output
function parseProfileOutput(output) {
  const lines = output.split('\n');
  const stats = {
    summary: {},
    ticks: [],
    callTree: [],
    cppEntries: [],
    jsEntries: [],
    callChains: []
  };

  let currentSection = null;
  let sectionBuffer = [];

  for (const line of lines) {
    // Detect sections
    if (line.includes('Statistical profiling result')) {
      currentSection = 'summary';
      continue;
    }
    if (line.includes('[Shared libraries]:')) {
      currentSection = 'shared';
      continue;
    }
    if (line.includes('[JavaScript]:')) {
      currentSection = 'javascript';
      continue;
    }
    if (line.includes('[C++ entries]:')) {
      currentSection = 'cpp';
      continue;
    }
    if (line.includes('[Bottom up (heavy) profile]:')) {
      currentSection = 'bottomup';
      continue;
    }
    if (line.includes('[Top down (heavy) profile]:')) {
      currentSection = 'topdown';
      continue;
    }

    // Parse summary line
    if (currentSection === 'summary' && line.includes('ticks')) {
      const match = line.match(/(\d+) ticks total \((\d+) events\)/);
      if (match) {
        stats.summary.totalTicks = parseInt(match[1], 10);
        stats.summary.events = parseInt(match[2], 10);
      }
    }

    // Parse ticks line
    const tickMatch = line.match(/^\s*(\d+)\s+(\d+\.\d)%\s+(\d+\.\d)%\s+(.*)$/);
    if (tickMatch) {
      const tick = {
        ticks: parseInt(tickMatch[1], 10),
        total: parseFloat(tickMatch[2]),
        nonlib: parseFloat(tickMatch[3]),
        name: tickMatch[4].trim()
      };
      stats.ticks.push(tick);

      // Categorize
      if (currentSection === 'javascript') {
        stats.jsEntries.push(tick);
      } else if (currentSection === 'cpp') {
        stats.cppEntries.push(tick);
      }
    }

    // Parse call chain entry (bottom-up format with indentation)
    if (currentSection === 'bottomup' || currentSection === 'topdown') {
      sectionBuffer.push(line);
    }
  }

  return stats;
}

// Extract call chains from bottom-up profile
function extractCallChains(lines) {
  const chains = [];
  const callTreeSection = [];
  let inBottomUp = false;

  // Find the bottom-up heavy profile section
  for (const line of lines) {
    if (line.includes('[Bottom up (heavy) profile]:')) {
      inBottomUp = true;
      continue;
    }
    if (inBottomUp) {
      if (line.startsWith('[') && line.includes(']:')) {
        break; // Next section
      }
      if (line.trim()) {
        callTreeSection.push(line);
      }
    }
  }

  // Parse the tree structure
  let currentRoot = null;
  let currentCallees = [];

  for (const line of callTreeSection) {
    // Match root entry: " ticks  total  name"
    const rootMatch = line.match(/^\s*(\d+)\s+(\d+\.\d)%\s+(.*)$/);
    if (rootMatch && !line.startsWith('  ')) {
      // Save previous root if exists
      if (currentRoot && currentCallees.length > 0) {
        chains.push({
          root: currentRoot,
          callees: [...currentCallees]
        });
      }
      currentRoot = {
        ticks: parseInt(rootMatch[1], 10),
        percent: parseFloat(rootMatch[2]),
        name: rootMatch[3].trim()
      };
      currentCallees = [];
    } else if (currentRoot) {
      // Match callee entry with indentation
      const calleeMatch = line.match(/^(\s+)(\d+)\s+(\d+\.\d)%\s+(.*)$/);
      if (calleeMatch) {
        const indent = calleeMatch[1].length;
        const depth = Math.floor(indent / 2);
        currentCallees.push({
          depth,
          ticks: parseInt(calleeMatch[2], 10),
          percent: parseFloat(calleeMatch[3]),
          name: calleeMatch[4].trim()
        });
      }
    }
  }

  // Don't forget the last root
  if (currentRoot && currentCallees.length > 0) {
    chains.push({
      root: currentRoot,
      callees: [...currentCallees]
    });
  }

  return chains;
}

// Filter functions based on pattern
function filterFunctions(functions, pattern, includeInternals) {
  if (includeInternals) return functions;

  const lowerPattern = pattern.toLowerCase();
  return functions.filter(fn => {
    const name = fn.name.toLowerCase();
    // Exclude native libraries
    if (name.includes('.so.') || name.includes('lib') && name.includes('.dylib')) {
      return false;
    }
    // Exclude profile script
    if (name.includes('.profile-script')) {
      return false;
    }
    // Include if matches pattern or if it's a Jaren file path
    return name.includes(lowerPattern) ||
           name.includes('jaren') ||
           name.includes('packages/validate') ||
           name.includes('packages/core') ||
           name.includes('packages/refs') ||
           (name.includes('.js:') && !name.includes('node_modules'));
  });
}

// Filter call chains to show only Jaren-related ones
function filterCallChains(chains) {
  return chains.filter(chain => {
    const allNames = [chain.root.name, ...chain.callees.map(c => c.name)].join(' ').toLowerCase();
    // Exclude chains that are only native/system code
    if (!allNames.includes('.js:') && !allNames.includes('jaren')) {
      return false;
    }
    // Must include at least one Jaren file
    return allNames.includes('packages/') || 
           allNames.includes('traverse.js') ||
           allNames.includes('schema.js') ||
           allNames.includes('index.js') ||
           allNames.includes('array.js') ||
           allNames.includes('object.js') ||
           allNames.includes('string.js') ||
           allNames.includes('combine.js') ||
           allNames.includes('number.js');
  });
}

// Clean up function name for display
function cleanFunctionName(name) {
  // Remove library paths
  return name
    .replace(/^.*\//, '') // Remove path
    .replace(/^.*\\/, '') // Remove Windows path
    .replace(/\s+\[.*\]$/, '') // Remove [SHARED], [CODE:...] etc
    .replace(/^.*node_modules\//, '');
}

// Format call tree for display
function formatCallTree(chains, maxFunctions, maxDepth) {
  const output = [];
  const seen = new Set();

  // Sort chains by root percentage (descending)
  chains.sort((a, b) => b.root.percent - a.root.percent);

  let count = 0;
  for (const chain of chains) {
    if (count >= maxFunctions) break;

    // Create unique key for deduplication
    const calleeKey = chain.callees.slice(0, maxDepth).map(c => c.name).join('->');
    const key = `${chain.root.name}->${calleeKey}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Skip if root is native code
    const rootName = chain.root.name;
    if (rootName.includes('.so.') || rootName.includes('.dylib') || rootName.includes('libnode')) {
      continue;
    }

    // Format the chain
    let line = `${chain.root.percent.toFixed(1).padStart(6)}%  ${cleanFunctionName(rootName)}`;
    output.push(line);

    // Add call chain with tree characters
    for (let i = 0; i < chain.callees.length && i < maxDepth - 1; i++) {
      const node = chain.callees[i];
      // Skip native library entries
      if (node.name.includes('.so.') || node.name.includes('.dylib') || node.name.includes('libnode')) {
        continue;
      }
      const isLast = i === chain.callees.length - 1 || i === maxDepth - 2;
      const indent = '        ' + '  '.repeat(node.depth);
      const prefix = isLast ? '└─ ' : '├─ ';
      line = `${indent}${prefix}${node.percent.toFixed(1)}% ${cleanFunctionName(node.name)}`;
      output.push(line);
    }

    output.push('');
    count++;
  }

  return output.join('\n');
}

// Generate summary statistics
function generateSummary(stats, filteredFunctions) {
  const totalJsTicks = stats.jsEntries.reduce((sum, e) => sum + e.ticks, 0);
  const totalTicks = stats.summary.totalTicks || totalJsTicks || 1;

  const jarenTicks = filteredFunctions.reduce((sum, f) => sum + f.ticks, 0);
  const jarenPercent = ((jarenTicks / totalTicks) * 100).toFixed(1);

  const lines = [
    'SUMMARY',
    '='.repeat(60),
    `Total ticks:     ${totalTicks.toLocaleString()}`,
    `JavaScript ticks: ${totalJsTicks.toLocaleString()} (${((totalJsTicks/totalTicks)*100).toFixed(1)}%)`,
    `Filtered functions: ${filteredFunctions.length}`,
    `JarenJS ticks:   ${jarenTicks.toLocaleString()} (${jarenPercent}%)`,
    ''
  ];

  if (filteredFunctions.length > 0) {
    lines.push('Top 5 JarenJS Functions by Time:');
    lines.push('-'.repeat(40));
    filteredFunctions.slice(0, 5).forEach((fn, i) => {
      const percent = ((fn.ticks / totalTicks) * 100).toFixed(1);
      const name = cleanFunctionName(fn.name);
      lines.push(`  ${i + 1}. ${name} (${percent}%)`);
    });
  }

  return lines.join('\n');
}

// Main function
async function main() {
  const options = parseArgs();

  if (options.help || !options.targetFile) {
    printHelp();
  }

  // Ensure target file format
  let targetFile = options.targetFile;
  if (!targetFile.startsWith('/')) {
    targetFile = '/' + targetFile;
  }

  console.log('='.repeat(80));
  console.log(`CALL GRAPH ANALYSIS: ${targetFile}`);
  console.log('='.repeat(80));
  console.log(`Iterations:      ${options.iterations.toLocaleString()}`);
  console.log(`Top functions:   ${options.topFunctions}`);
  console.log(`Max depth:       ${options.maxDepth}`);
  console.log(`Filter pattern:  ${options.filter}`);
  console.log('');

  // Create temporary script
  const tempScriptPath = path.join(rootDir, '.profile-script.mjs');
  const scriptContent = generateProfilingScript(targetFile, options.iterations, WARMUP_ITERATIONS);
  fs.writeFileSync(tempScriptPath, scriptContent);

  // Create temp directory for isolate logs
  const tempDir = path.join(os.tmpdir(), `jaren-profile-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Run Node.js with --prof
    console.log('Running profiler (this may take a while)...');
    console.log('');

    const nodeCmd = process.execPath;
    const args = [
      '--prof',
      `--logfile=${tempDir}/isolate-*.log`,
      tempScriptPath
    ];

    if (options.verbose) {
      console.log('Command:', nodeCmd, args.join(' '));
    }

    const result = spawn(nodeCmd, args, {
      cwd: rootDir,
      stdio: options.verbose ? 'inherit' : 'pipe',
    });

    await new Promise((resolve, reject) => {
      result.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Profiling exited with code ${code}`));
        }
      });
      result.on('error', reject);
    });

    // Find the isolate log file
    const logFiles = fs.readdirSync(tempDir).filter(f => f.startsWith('isolate-') && f.endsWith('.log'));
    if (logFiles.length === 0) {
      throw new Error('No profiler log file generated');
    }

    const logFile = path.join(tempDir, logFiles[0]);

    // Process with --prof-process
    console.log('Processing profile data...');
    console.log('');

    const processedOutput = execSync(
      `"${nodeCmd}" --prof-process "${logFile}"`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );

    // Parse the output
    const stats = parseProfileOutput(processedOutput);

    // Filter JarenJS functions
    const filteredJs = filterFunctions(stats.jsEntries, options.filter, options.includeInternals);
    const sortedFiltered = filteredJs.sort((a, b) => b.ticks - a.ticks);

    // Generate output
    console.log(generateSummary(stats, sortedFiltered));
    console.log('');

    // Print hottest JavaScript functions
    console.log('='.repeat(80));
    console.log(`HOTTEST JAVASCRIPT FUNCTIONS (Top ${options.topFunctions})`);
    console.log('='.repeat(80));
    console.log(`${'Ticks'.padStart(8)} | ${'%'.padStart(6)} | Function`);
    console.log('-'.repeat(80));

    const effectiveTotal = stats.summary.totalTicks || stats.jsEntries.reduce((s, e) => s + e.ticks, 0) || 1;
    const displayCount = Math.min(options.topFunctions, sortedFiltered.length);
    for (let i = 0; i < displayCount; i++) {
      const fn = sortedFiltered[i];
      const percent = ((fn.ticks / effectiveTotal) * 100).toFixed(1);
      const name = cleanFunctionName(fn.name);
      console.log(`${fn.ticks.toString().padStart(8)} | ${percent.padStart(6)} | ${name}`);
    }

    // Extract and display call chains
    const lines = processedOutput.split('\n');
    const chains = extractCallChains(lines);
    const jarenChains = filterCallChains(chains);

    if (jarenChains.length > 0) {
      console.log('');
      console.log('='.repeat(80));
      console.log('CALL CHAINS (Bottom-Up Profile)');
      console.log('='.repeat(80));
      console.log('');
      console.log(formatCallTree(jarenChains, options.topFunctions, options.maxDepth));
    }

    // Print optimization hints
    console.log('='.repeat(80));
    console.log('OPTIMIZATION HINTS');
    console.log('='.repeat(80));

    if (sortedFiltered.length > 0) {
      const topFn = sortedFiltered[0];
      const topPercent = ((topFn.ticks / effectiveTotal) * 100).toFixed(1);
      console.log(`• Hot function: ${cleanFunctionName(topFn.name)} (${topPercent}% of time)`);

      // Detect deep recursion
      const maxChainDepth = jarenChains.length > 0 
        ? Math.max(...jarenChains.map(c => c.callees.length)) 
        : 0;
      if (maxChainDepth > 5) {
        console.log(`• Deep call chains detected: max depth = ${maxChainDepth}`);
        console.log('  Consider inlining or flattening call chains');
      }

      // Detect repeated patterns
      const fnNames = sortedFiltered.slice(0, 10).map(f => cleanFunctionName(f.name));
      const refCount = fnNames.filter(n => n.toLowerCase().includes('ref')).length;
      if (refCount > 3) {
        console.log(`• Ref resolution heavy: ${refCount}/10 hot functions involve refs`);
        console.log('  Consider caching or pre-compiling refs');
      }

      // Detect traverse.js dominance
      const traverseCount = fnNames.filter(n => n.includes('traverse.js')).length;
      if (traverseCount > 3) {
        console.log(`• Schema traversal heavy: ${traverseCount}/10 hot functions in traverse.js`);
        console.log('  Consider pre-compiling schemas or caching traversal results');
      }
    } else {
      console.log('No JarenJS functions found in profile. Try:');
      console.log('  • Running with more iterations');
      console.log('  • Using --include-internals to see all functions');
      console.log('  • Adjusting --filter pattern');
    }

    console.log('');

  } finally {
    // Cleanup
    try {
      fs.unlinkSync(tempScriptPath);
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
