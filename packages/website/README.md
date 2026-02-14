# JarenJS Website

The official GitHub Pages website for JarenJS - a modern JSON Schema validator for JavaScript.

## Features

- **Interactive Playground**: Test JSON Schema validation in real-time
- **Benchmark Visualizations**: Performance comparisons with AJV
- **Documentation**: Complete guide to using JarenJS
- **Code Examples**: Common validation patterns and use cases

## Tech Stack

- **Build Tool**: Vite 6.x
- **Frontend**: React 19.x
- **Styling**: Tailwind CSS 4.x
- **Animation**: Framer Motion
- **Icons**: Lucide React
- **Testing**: Vitest + React Testing Library

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run tests
npm test

# Deploy to GitHub Pages
npm run deploy
```

## Project Structure

```
src/
├── components/
│   ├── ui/           # UI primitives (Button, Card, Input, etc.)
│   ├── layout/       # Layout components (Header, Footer)
│   ├── demo/         # Interactive demo components
│   ├── charts/       # Performance visualization
│   └── features/     # Feature showcase components
├── hooks/            # Custom React hooks
├── lib/              # Utility functions
├── pages/            # Page components
├── App.jsx           # Main App component
└── main.jsx          # Entry point
```

## GitHub Pages Deployment

The site is configured for GitHub Pages deployment. The base URL is set to `/jarenjs/` in `vite.config.js`.

To deploy:

```bash
npm run deploy
```

This builds the project and pushes the `dist` folder to the `gh-pages` branch.

## License

MIT - Same as JarenJS
