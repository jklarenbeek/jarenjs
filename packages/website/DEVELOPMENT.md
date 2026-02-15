# JarenJS GitHub Pages Website - Implementation Plan

> **Version:** 1.0
> **Date:** 2026-02-13
> **Status:** Planning Phase

---

## Overview

This document outlines the implementation plan for a GitHub Pages single page application (SPA) for JarenJS. The website will serve as a demo site showcasing JarenJS features, performance benchmarks, and interactive schema validation capabilities.

**Key Technologies:**
- **Build Tool:** Vite 7.x
- **Frontend Framework:** React 19.x
- **Styling:** Tailwind CSS 4.x
- **Animation:** Framer Motion
- **Icons:** Lucide React
- **Deployment:** GitHub Pages via gh-pages

---

## 1. Project Structure & Package Setup

### 1.1 Create New Package Directory

Create a new workspace package `packages/website` for the GitHub Pages application:

```
packages/website/
├── public/                  # Static assets
│   ├── results.json         # Benchmark results (CI-generated)
│   └── schemas/             # Example schemas for demos
├── src/
│   ├── components/          # React components
│   │   ├── ui/              # shadcn-style UI primitives
│   │   ├── layout/          # Layout components (Header, Footer, etc.)
│   │   ├── demo/            # Interactive demo components
│   │   └── charts/          # Performance chart components
│   ├── hooks/               # Custom React hooks
│   ├── lib/                 # Utility functions
│   ├── pages/               # Page components
│   ├── App.jsx              # Main App component
│   └── main.jsx             # Entry point
├── index.html               # HTML template
├── package.json             # Package dependencies
├── vite.config.js           # Vite configuration
├── tailwind.config.js       # Tailwind CSS configuration
├── eslint.config.js         # ESLint configuration
└── README.md                # Package documentation
```

### 1.2 Package.json Configuration

```json
{
  "name": "jarenjs",
  "private": false,
  "version": "0.9.2",
  "description": "Jaren is a JSON Schema Karen Compiler written in vanilla Javascript.",
  "author": "joham",
  "license": "MIT",
  "type": "module",
  "module": "./dist/index.js",
  "repository": {
    "type": "git",
    "url": "https://github.com/jklarenbeek/jarenjs.git"
  },
  "files": [
    "./dist",
    "./src"
  ],
  "workspaces": [
    "./packages/*"
  ],
  "scripts": {
    "clean": "rimraf --glob ./packages/**/dist/*.{js,map}",
    "lint": "eslint ./packages/**/*.js",
    "test": "node --no-warnings=ExperimentalWarning --test test/**/*.test.js",
    "test:core": "node --no-warnings=ExperimentalWarning --test test/core/**/*.test.js",
    "test:validate": "node --no-warnings=ExperimentalWarning --test test/validate/**/*.test.js",
    "cover": "c8 --reporter=lcov node --no-warnings=ExperimentalWarning --test test/**/*.test.js",
    "cover:core": "c8 --reporter=lcov node --no-warnings=ExperimentalWarning --test test/core/**/*.test.js",
    "cover:validate": "c8 --reporter=lcov node --no-warnings=ExperimentalWarning --test test/validate/**/*.test.js",
    "cover:profiler": "npx c8 --reporter=lcov --all --exclude packages/_ --exclude test/ --exclude coverage/ node benchmark/profiler.js --profile-all --iterations 1000",
    "build": "npm run build --workspaces --if-present",
    "build:jaren": "node esbuild.config.js",
    "version:patch": "npm version patch --no-git-tag-version --ws --include-workspace-root",
    "version:minor": "npm version minor --no-git-tag-version --ws --include-workspace-root",
    "version:major": "npm version major --no-git-tag-version --ws --include-workspace-root",
    "commit:linux": "git commit -am v$npm_package_version && git tag v$npm_package_version",
    "commit:win32": "git commit -am v%npm_package_version% && git tag v%npm_package_version%",
    "push": "git push && git push --tags",
    "benchmark": "node ./benchmark/index.js"
  },
  "keywords": [
    "JSON",
    "schema",
    "validator",
    "validation",
    "jsonschema",
    "json-schema",
    "json-schema-validator",
    "json-schema-validation",
    "javascript",
    "typescript",
    "expressive",
    "typechecking"
  ],
  "engines": {
    "node": ">=21.3.0"
  },
  "browserslist": [
    "last 1 chrome version",
    "last 1 chromeandroid version",
    "last 1 firefox version"
  ],
  "devDependencies": {
    "@eslint/js": "^9.9.1",
    "c8": "^10.1.2",
    "esbuild": "0.23.1",
    "eslint": "^9.9.1",
    "eslint-plugin-json": "^4.0.1",
    "globals": "^15.9.0",
    "lefthook": "^1.7.14",
    "rimraf": "^6.0.1",
    "turbo": "^2.1.1"
  },
  "dependencies": {
    "@types/node": "^22.5.5",
    "@jarenjs/core": "*",
    "@jarenjs/validate": "*",
    "@jarenjs/formats": "*",
    "@jarenjs/refs": "*"
  }
}
```

### 1.3 Root Package.json Workspace Update

Add the new website package to the root `package.json` workspaces:

```json
{
  "workspaces": [
    "./packages/*"
  ]
}
```

---

## 2. Vite Configuration

### 2.1 vite.config.js

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  base: '/jarenjs/',  // GitHub Pages base URL
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@components': resolve(__dirname, 'src/components'),
      '@hooks': resolve(__dirname, 'src/hooks'),
      '@lib': resolve(__dirname, 'src/lib'),
      '@pages': resolve(__dirname, 'src/pages'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Separate vendor chunks for better caching
          react: ['react', 'react-dom', 'react-router-dom'],
          motion: ['framer-motion'],
          jaren: ['@jarenjs/validate', '@jarenjs/core', '@jarenjs/formats'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
  },
});
```

### 2.2 Key Vite Optimizations

| Feature | Configuration | Purpose |
|---------|---------------|---------|
| Base URL | `base: '/jarenjs/'` | Required for GitHub Pages subdirectory |
| Path Aliases | `@/` prefix | Clean imports |
| Manual Chunks | Vendor separation | Better caching |
| Source Maps | Enabled | Debugging support |
| React SWC | `@vitejs/plugin-react-swc` | Fast compilation |
| Tailwind Vite | `@tailwindcss/vite` | Native Tailwind 4 integration |

---

## 3. Tailwind CSS Integration

### 3.1 CSS Entry File (src/index.css)

```css
@import "tailwindcss";
@import "tailwindcss-animate";

@theme {
  /* Custom colors matching JarenJS branding */
  --color-primary: #3b82f6;
  --color-primary-dark: #2563eb;
  --color-secondary: #64748b;
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-error: #ef4444;

  /* Custom animations */
  --animate-fade-in: fade-in 0.3s ease-out;
  --animate-slide-up: slide-up 0.4s ease-out;

  /* Custom fonts */
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

@layer base {
  body {
    @apply antialiased bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100;
  }

  code {
    @apply font-mono text-sm;
  }
}

@layer utilities {
  .text-balance {
    text-wrap: balance;
  }
}
```

### 3.2 Tailwind Configuration (if needed)

Tailwind CSS v4 uses CSS-based configuration. For custom utilities, extend via CSS.

---

## 4. React Application Structure

### 4.1 Application Architecture

```
src/
├── components/
│   ├── ui/                    # Base UI components (Button, Card, Input, etc.)
│   │   ├── button.jsx
│   │   ├── card.jsx
│   │   ├── input.jsx
│   │   ├── textarea.jsx
│   │   ├── select.jsx
│   │   ├── badge.jsx
│   │   ├── tabs.jsx
│   │   └── code-block.jsx
│   ├── layout/                # Layout components
│   │   ├── Header.jsx
│   │   ├── Footer.jsx
│   │   ├── Sidebar.jsx
│   │   └── Container.jsx
│   ├── demo/                  # Interactive demo components
│   │   ├── SchemaEditor.jsx       # JSON Schema editor
│   │   ├── DataInput.jsx          # Data JSON input
│   │   ├── ValidationResult.jsx   # Validation output display
│   │   ├── SchemaForm.jsx         # Auto-generated form from schema
│   │   └── LiveValidator.jsx      # Combined live validation demo
│   ├── charts/                # Performance visualization
│   │   ├── BenchmarkChart.jsx     # Main performance chart
│   │   ├── ComparisonTable.jsx    # Jaren vs AJV table
│   │   └── MetricsCard.jsx        # Individual metric cards
│   └── features/              # Feature showcase components
│       ├── KeywordBadge.jsx
│       ├── FeatureCard.jsx
│       └── DraftSupport.jsx
├── hooks/
│   ├── useJarenValidator.js   # Hook for Jaren validation
│   ├── useBenchmarkData.js    # Hook for fetching benchmark results
│   ├── useSchemaForm.js       # Hook for schema-to-form generation
│   └── useLocalStorage.js     # Persist user preferences
├── lib/
│   ├── utils.js               # Utility functions (cn helper)
│   ├── schemaFormGenerator.js # Schema to form field mapping
│   └── formatters.js          # Data formatting helpers
├── pages/
│   ├── Home.jsx               # Landing page
│   ├── Playground.jsx         # Interactive validation playground
│   ├── Benchmarks.jsx         # Performance benchmarks page
│   ├── Documentation.jsx      # Feature documentation
│   └── Examples.jsx           # Code examples gallery
├── App.jsx                    # Main router and layout
└── main.jsx                   # Application entry point
```

### 4.2 Main App Structure (App.jsx)

```jsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Header } from '@components/layout/Header';
import { Footer } from '@components/layout/Footer';
import { Home } from '@pages/Home';
import { Playground } from '@pages/Playground';
import { Benchmarks } from '@pages/Benchmarks';
import { Documentation } from '@pages/Documentation';
import { Examples } from '@pages/Examples';

function App() {
  return (
    <BrowserRouter basename="/jarenjs">
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/playground" element={<Playground />} />
            <Route path="/benchmarks" element={<Benchmarks />} />
            <Route path="/docs" element={<Documentation />} />
            <Route path="/examples" element={<Examples />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
```

---

## 5. Testing Setup

### 5.1 Vitest Configuration

Vitest is already configured in `vite.config.js`. Add test setup file:

```javascript
// src/test/setup.js
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// Cleanup after each test
afterEach(() => {
  cleanup();
});
```

### 5.2 Test Directory Structure

```
src/
├── test/
│   ├── setup.js               # Test setup
│   ├── utils/                 # Test utilities
│   └── __mocks__/             # Mock files
├── components/
│   └── ui/
│       └── button.test.jsx    # Component tests co-located
└── hooks/
    └── useJarenValidator.test.js
```

### 5.3 Example Component Test

```jsx
// components/ui/button.test.jsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './button';

describe('Button', () => {
  it('renders with default variant', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('handles click events', () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click me</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
```

---

## 6. Core Features Implementation

### 6.1 Jaren Validator Hook (useJarenValidator.js)

```javascript
import { useState, useCallback, useRef, useEffect } from 'react';
import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

export function useJarenValidator(options = {}) {
  const [errors, setErrors] = useState([]);
  const [isValid, setIsValid] = useState(null);
  const validatorRef = useRef(null);
  const compiledRef = useRef(null);

  // Initialize validator instance
  useEffect(() => {
    validatorRef.current = new JarenValidator({
      skipErrors: false,
      useGrapheme: true,
      ...options,
    }).addFormats(formats.stringFormats);
  }, []);

  // Compile schema
  const compileSchema = useCallback((schema) => {
    if (!validatorRef.current) return null;

    try {
      compiledRef.current = validatorRef.current.compile(schema);
      setErrors([]);
      setIsValid(null);
      return true;
    } catch (err) {
      setErrors([{ message: err.message, keyword: 'compile' }]);
      setIsValid(false);
      return false;
    }
  }, []);

  // Validate data
  const validate = useCallback((data) => {
    if (!compiledRef.current) return null;

    const valid = compiledRef.current(data);
    setIsValid(valid);

    if (!valid && validatorRef.current) {
      setErrors(validatorRef.current.errors || []);
    } else {
      setErrors([]);
    }

    return valid;
  }, []);

  return {
    compileSchema,
    validate,
    errors,
    isValid,
  };
}
```

### 6.2 Schema-to-Form Generator

The form generator will interpret standard JSON Schema keywords to create form fields:

| Schema Keyword | Form Field Type |
|----------------|-----------------|
| `type: "string"` | Text input |
| `type: "number"` / `integer` | Number input |
| `type: "boolean"` | Checkbox/Toggle |
| `type: "array"` | Dynamic list with add/remove |
| `type: "object"` | Nested form section |
| `enum` | Select dropdown |
| `const` | Read-only display |
| `format: "date"` | Date picker |
| `format: "email"` | Email input |
| `minLength` / `maxLength` | Input with validation |
| `pattern` | Input with regex validation |
| `required` | Field marked as required |

**Implementation Approach:**

```javascript
// lib/schemaFormGenerator.js

export function generateFormFields(schema, path = '') {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  const fields = [];

  // Handle object type
  if (schema.type === 'object' && schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const fieldPath = path ? `${path}.${key}` : key;
      const isRequired = schema.required?.includes(key);

      fields.push({
        path: fieldPath,
        name: key,
        schema: propSchema,
        required: isRequired,
        type: getFieldType(propSchema),
        nested: propSchema.type === 'object' ||
                (propSchema.type === 'array' && propSchema.items?.type === 'object'),
        children: propSchema.type === 'object'
          ? generateFormFields(propSchema, fieldPath)
          : null,
      });
    }
  }

  // Handle array type with items
  if (schema.type === 'array' && schema.items) {
    fields.push({
      path,
      name: 'items',
      schema: schema.items,
      type: 'array',
      arrayItemType: getFieldType(schema.items),
      nested: true,
    });
  }

  return fields;
}

function getFieldType(schema) {
  if (schema.enum) return 'enum';
  if (schema.const) return 'const';

  switch (schema.type) {
    case 'string':
      if (schema.format === 'email') return 'email';
      if (schema.format === 'date' || schema.format === 'date-time') return 'date';
      if (schema.format === 'uri' || schema.format === 'url') return 'url';
      return 'text';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    default:
      return 'text';
  }
}
```

### 6.3 Benchmark Data Loading

```javascript
// hooks/useBenchmarkData.js
import { useState, useEffect } from 'react';

export function useBenchmarkData() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadBenchmarks() {
      try {
        // Load the results.json generated by CI
        const response = await fetch('/jarenjs/results.json');
        if (!response.ok) {
          throw new Error('Failed to load benchmark results');
        }
        const results = await response.json();
        setData(processBenchmarkData(results));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    loadBenchmarks();
  }, []);

  return { data, loading, error };
}

function processBenchmarkData(raw) {
  // Transform raw benchmark data for visualization
  return {
    summary: {
      averageRatio: raw.averageRatio,
      jarenFaster: raw.jarenFaster,
      ajvFaster: raw.ajvFaster,
      totalTests: raw.totalTests,
    },
    byCategory: groupByCategory(raw.results),
    slowestTests: raw.results
      .filter(r => r.ratio > 5)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 10),
  };
}
```

---

## 7. Page Designs

### 7.1 Home Page

**Sections:**
1. **Hero** - JarenJS logo, tagline, CTA buttons
2. **Features Grid** - Key features with icons
3. **Quick Stats** - Test count, performance ratio, draft support
4. **Code Preview** - Quick usage example
5. **Get Started** - Links to docs and playground

### 7.2 Playground Page

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  SCHEMA EDITOR          │  DATA INPUT                      │
│  (JSON/CodeMirror)      │  (JSON/Textarea)                 │
│                         │                                  │
│  {                      │  {                               │
│    "type": "object",    │    "name": "John",               │
│    "properties": {      │    "age": 30                     │
│      ...                │  }                               │
│    }                    │                                  │
│  }                      │                                  │
├─────────────────────────┼──────────────────────────────────┤
│  SCHEMA-BASED FORM      │  VALIDATION RESULT               │
│  (Auto-generated)       │  ✓ Valid / ✗ Invalid             │
│                         │  Errors displayed with path      │
└─────────────────────────────────────────────────────────────┘
```

### 7.3 Benchmarks Page

**Components:**
- **Summary Cards** - Average ratio, tests faster/slower
- **Comparison Chart** - Bar chart Jaren vs AJV by category
- **Detailed Table** - Sortable table of all tests
- **Category Breakdown** - Filter by test category

### 7.4 Documentation Page

**Sections:**
- Supported Keywords (with badges for draft version)
- Supported Formats
- Configuration Options
- Code Examples

### 7.5 Examples Page

**Example Gallery:**
- Basic type validation
- Object with properties
- Array validation
- $ref usage
- Conditional validation (if/then/else)
- Custom formats

---

## 8. CI/CD Pipeline (GitHub Actions)

### 8.1 Workflow File (.github/workflows/deploy.yml)

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  # Run benchmarks and generate results
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run benchmarks
        run: node benchmark/profiler.js --profile-all --iterations 5000 --output json --success-only

      - name: Upload benchmark results
        uses: actions/upload-artifact@v4
        with:
          name: benchmark-results
          path: results.json
          retention-days: 30

  # Build and deploy website
  build:
    needs: benchmark
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build packages
        run: npm run build --workspaces --if-present

      - name: Download benchmark results
        uses: actions/download-artifact@v4
        with:
          name: benchmark-results
          path: packages/website/public/

      - name: Build website
        run: |
          cd packages/website
          npm run build

      - name: Setup Pages
        uses: actions/configure-pages@v4

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: packages/website/dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

### 8.2 Alternative: gh-pages Package Deployment

For simpler deployment using the gh-pages npm package:

```json
// package.json scripts
{
  "deploy": "gh-pages -d dist"
}
```

---

## 9. Implementation Phases

### Phase 1: Project Setup (Day 1)
- [ ] Create `packages/website` directory structure
- [ ] Initialize package.json with dependencies
- [ ] Configure Vite with React and Tailwind
- [ ] Set up ESLint and Prettier
- [ ] Create base layout components (Header, Footer)
- [ ] Configure GitHub Pages base path

### Phase 2: Core UI Components (Day 2)
- [ ] Create UI primitive components (Button, Card, Input, etc.)
- [ ] Implement dark mode support
- [ ] Create code editor component ( Monaco or CodeMirror-lite)
- [ ] Set up React Router
- [ ] Create page shell components

### Phase 3: Jaren Integration (Day 3)
- [ ] Implement `useJarenValidator` hook
- [ ] Create SchemaEditor component
- [ ] Create DataInput component
- [ ] Create ValidationResult component
- [ ] Build Playground page

### Phase 4: Schema-to-Form Generator (Day 4)
- [ ] Implement form field type mapping
- [ ] Create form field components for each type
- [ ] Handle nested objects
- [ ] Handle arrays with add/remove
- [ ] Integrate with validation

### Phase 5: Benchmark Visualization (Day 5)
- [ ] Create benchmark data fetching hook
- [ ] Implement comparison chart component
- [ ] Create metrics cards
- [ ] Build Benchmarks page
- [ ] Add filtering by category

### Phase 6: Content Pages (Day 6)
- [ ] Build Home page with features
- [ ] Build Documentation page
- [ ] Build Examples page
- [ ] Add copy-to-clipboard for code blocks
- [ ] Add SEO meta tags

### Phase 7: Testing & Polish (Day 7)
- [ ] Write component tests
- [ ] Write hook tests
- [ ] Test responsive design
- [ ] Optimize bundle size
- [ ] Add loading states
- [ ] Error boundary handling

### Phase 8: CI/CD Setup (Day 8)
- [ ] Create GitHub Actions workflow
- [ ] Configure benchmark job
- [ ] Configure build and deploy job
- [ ] Test deployment to GitHub Pages
- [ ] Verify benchmark results loading

---

## 10. Key Considerations

### 10.1 Performance Optimizations

| Strategy | Implementation |
|----------|----------------|
| Code Splitting | Route-based lazy loading |
| Vendor Chunking | Separate React, Framer Motion, Jaren |
| Tree Shaking | Import only used format validators |
| Memoization | React.memo for static components |
| Lazy Loading | Benchmark charts loaded on demand |

### 10.2 Accessibility

- Semantic HTML structure
- ARIA labels for interactive elements
- Keyboard navigation support
- Focus indicators
- Color contrast compliance (WCAG 4.5:1)

### 10.3 Browser Support

Target modern browsers only (per browserslist):
- Last 1 Chrome version
- Last 1 Chrome Android version
- Last 1 Firefox version

### 10.4 Bundle Size Budget

| Chunk | Target Size |
|-------|-------------|
| Main entry | < 50 KB |
| React vendors | < 100 KB |
| Jaren packages | < 150 KB |
| Total initial | < 300 KB |

---

## 11. What It Will NOT Do (Constraints)

As specified in requirements:

1. **No Server-Side Rendering** - Pure client-side SPA
2. **No Backend Logic** - No authentication, no database
3. **No Legacy Browser Support** - Modern browsers only
4. **No Unnecessary Dependencies** - Keep bundle small
5. **No New Schema Keywords** - Use standard JSON Schema only

---

## 12. Success Criteria

- [x] Website deployed to `https://jklarenbeek.github.io/jarenjs/`
- [x] All 773 tests passing in CI (`npm run test`)
- [\] Benchmark results display correctly
- [\] Schema playground validates in real-time
- [x] Auto-generated forms work for complex schemas
- [x] Responsive design on mobile/tablet/desktop
- [x] Lighthouse score > 90 for Performance, Accessibility, Best Practices

---

## Appendix A: Reference Dependencies (Latest Versions)

Based on the yijingjs reference project and latest available versions:

**Production:**
- react: ^19.1.1
- react-dom: ^19.1.1
- framer-motion: ^12.23.24
- lucide-react: ^0.548.0
- tailwind-merge: ^3.3.1
- tailwindcss-animate: ^1.0.7
- clsx: ^2.1.1

**Development:**
- vite: ^7.1.7
- @vitejs/plugin-react-swc: ^4.1.0
- @tailwindcss/vite: ^4.1.16
- tailwindcss: ^4.1.16
- eslint: ^9.36.0
- @eslint/js: ^9.36.0
- vitest: ^4.0.5
- @testing-library/react: ^16.3.0
- @testing-library/jest-dom: ^6.9.1
- gh-pages: ^6.3.0

---
