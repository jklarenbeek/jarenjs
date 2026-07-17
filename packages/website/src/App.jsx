import { HashRouter, Routes, Route } from 'react-router-dom';
import { Header } from '@components/layout/Header';
import { Footer } from '@components/layout/Footer';
import { ErrorBoundary } from '@components/layout/ErrorBoundary';
import { Home } from '@pages/Home';
import { Playground } from '@pages/Playground';
import { Benchmarks } from '@pages/Benchmarks';
import { Documentation } from '@pages/Documentation';
import { Examples } from '@pages/Examples';

function App() {
  return (
    <HashRouter>
      <div className="min-h-screen flex flex-col bg-background">
        <Header />
        <main className="flex-1">
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/playground" element={<Playground />} />
              <Route path="/benchmarks" element={<Benchmarks />} />
              <Route path="/docs" element={<Documentation />} />
              <Route path="/examples" element={<Examples />} />
            </Routes>
          </ErrorBoundary>
        </main>
        <Footer />
      </div>
    </HashRouter>
  );
}

export default App;
