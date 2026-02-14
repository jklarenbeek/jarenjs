import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@lib/utils';
import { Button } from '@components/ui/button';
import { Menu, X, Github, Moon, Sun } from 'lucide-react';

const navItems = [
  { path: '/', label: 'Home' },
  { path: '/playground', label: 'Playground' },
  { path: '/benchmarks', label: 'Benchmarks' },
  { path: '/docs', label: 'Docs' },
  { path: '/examples', label: 'Examples' },
];

function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const location = useLocation();
  
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);
  
  const toggleMenu = () => setIsMenuOpen(!isMenuOpen);
  const closeMenu = () => setIsMenuOpen(false);
  
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-lg">
              J
            </div>
            <span className="text-xl font-bold">JarenJS</span>
          </Link>
          
          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-6">
            {navItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'text-sm font-medium transition-colors hover:text-primary',
                  location.pathname === item.path 
                    ? 'text-foreground' 
                    : 'text-muted-foreground'
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          
          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsDark(!isDark)}
              className="hidden sm:flex"
            >
              {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
            
            <a
              href="https://github.com/jklarenbeek/jarenjs"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline-flex"
            >
              <Button variant="ghost" size="icon">
                <Github className="h-5 w-5" />
              </Button>
            </a>
            
            {/* Mobile Menu Button */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={toggleMenu}
            >
              {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>
      </div>
      
      {/* Mobile Navigation */}
      {isMenuOpen && (
        <div className="md:hidden border-t">
          <div className="container mx-auto px-4 py-4 space-y-2">
            {navItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                onClick={closeMenu}
                className={cn(
                  'block px-3 py-2 rounded-md text-sm font-medium transition-colors',
                  location.pathname === item.path 
                    ? 'bg-primary/10 text-primary' 
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                {item.label}
              </Link>
            ))}
            <div className="flex items-center gap-2 pt-2 border-t">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsDark(!isDark)}
                className="flex-1"
              >
                {isDark ? <Sun className="h-4 w-4 mr-2" /> : <Moon className="h-4 w-4 mr-2" />}
                {isDark ? 'Light Mode' : 'Dark Mode'}
              </Button>
              <a
                href="https://github.com/jklarenbeek/jarenjs"
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1"
              >
                <Button variant="ghost" size="sm" className="w-full">
                  <Github className="h-4 w-4 mr-2" />
                  GitHub
                </Button>
              </a>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

export { Header };
