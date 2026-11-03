import { Component } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/glaze/ui/alert";
import { Button } from "@/components/glaze/ui/button";

// A render error in one place must not blank the whole window. Shows what
// went wrong and lets the person try again without restarting the app.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Atlas hit a render error:", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;

    if (!error) return this.props.children;

    return (
      <div className="glaze flex h-full w-full items-center justify-center bg-page p-6 text-text-1">
        <Alert status="fail" className="max-w-measure">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>
            {error?.message || "Atlas could not draw this screen."}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }
}
