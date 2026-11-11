import { Component, type ErrorInfo, type ReactNode } from "react";
import { PageCrashed } from "./page-crashed";

type Props = { children: ReactNode };
type State = { crashed: boolean };

/**
 * Catches render failures outside the router (providers, overlays) so the
 * person sees a recovery screen instead of a blank page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ui crashed", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.crashed) {
      return (
        <PageCrashed
          onReload={() => {
            this.setState({ crashed: false });
          }}
        />
      );
    }
    return this.props.children;
  }
}
