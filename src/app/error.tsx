'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="error-page"><h1>Context Master could not open this view</h1><p>Reload the workspace. Your saved library remains on this Mac.</p><button className="button button-primary" onClick={reset}>Reload workspace</button></main>;
}
