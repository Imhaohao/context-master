import Link from 'next/link';
export default function NotFound() { return <main className="error-page"><h1>This view does not exist</h1><Link className="button button-primary" href="/">Open the library</Link></main>; }
