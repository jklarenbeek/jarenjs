import { Link } from 'react-router-dom';
import { Github, Package, FileText, Heart } from 'lucide-react';

function Footer() {
  const currentYear = new Date().getFullYear();
  
  return (
    <footer className="border-t bg-muted/40">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="md:col-span-2">
            <Link to="/" className="flex items-center gap-2 mb-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-lg">
                J
              </div>
              <span className="text-xl font-bold">JarenJS</span>
            </Link>
            <p className="text-muted-foreground text-sm max-w-sm">
              A modern JSON Schema validator for JavaScript with excellent performance, 
              full draft support, and a developer-friendly API.
            </p>
          </div>
          
          {/* Links */}
          <div>
            <h3 className="font-semibold mb-4">Resources</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link to="/playground" className="hover:text-primary transition-colors">
                  Playground
                </Link>
              </li>
              <li>
                <Link to="/benchmarks" className="hover:text-primary transition-colors">
                  Benchmarks
                </Link>
              </li>
              <li>
                <Link to="/docs" className="hover:text-primary transition-colors">
                  Documentation
                </Link>
              </li>
              <li>
                <Link to="/examples" className="hover:text-primary transition-colors">
                  Examples
                </Link>
              </li>
            </ul>
          </div>
          
          {/* External Links */}
          <div>
            <h3 className="font-semibold mb-4">Links</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <a 
                  href="https://github.com/jklarenbeek/jarenjs" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="hover:text-primary transition-colors inline-flex items-center gap-1"
                >
                  <Github className="h-3 w-3" />
                  GitHub
                </a>
              </li>
              <li>
                <a 
                  href="https://www.npmjs.com/package/jarenjs" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="hover:text-primary transition-colors inline-flex items-center gap-1"
                >
                  <Package className="h-3 w-3" />
                  npm
                </a>
              </li>
              <li>
                <a 
                  href="https://json-schema.org/" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="hover:text-primary transition-colors inline-flex items-center gap-1"
                >
                  <FileText className="h-3 w-3" />
                  JSON Schema Spec
                </a>
              </li>
            </ul>
          </div>
        </div>
        
        {/* Bottom Bar */}
        <div className="mt-12 pt-8 border-t flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
          <p>&copy; {currentYear} JarenJS. MIT License.</p>
          <p className="flex items-center gap-1">
            Made with <Heart className="h-4 w-4 text-red-500 fill-red-500" /> by joham
          </p>
        </div>
      </div>
    </footer>
  );
}

export { Footer };
