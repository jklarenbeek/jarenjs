import { Component } from 'react';
import PropTypes from 'prop-types';

/**
 * Route-level error boundary: a crash in one page (or one playground
 * engine) degrades to a readable message instead of blanking the app.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Route crashed:', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="container mx-auto px-4 py-16 text-center space-y-3">
          <h1 className="text-2xl font-bold">Something broke on this page</h1>
          <p className="text-muted-foreground text-sm max-w-xl mx-auto">
            {String(this.state.error?.message ?? this.state.error)}
          </p>
          <p className="text-sm">
            <a className="underline" href="https://github.com/jklarenbeek/jarenjs/issues" target="_blank" rel="noopener noreferrer">
              File an issue
            </a>{' '}
            with the message above — it helps.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

ErrorBoundary.propTypes = {
  children: PropTypes.node,
};

export { ErrorBoundary };
