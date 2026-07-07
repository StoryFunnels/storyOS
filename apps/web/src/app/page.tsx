import { healthSchema } from '@storyos/schemas';

export default function Home() {
  // Proves the shared schemas package is wired into the web app.
  const health = healthSchema.parse({ status: 'ok', name: 'StoryOS', version: '0.0.0' });

  return (
    <main style={{ fontFamily: 'sans-serif', padding: '4rem', background: '#FAF7F1', minHeight: '100vh' }}>
      <h1 style={{ color: '#0F1729' }}>StoryOS</h1>
      <p style={{ color: '#6B6658' }}>
        {health.name} web · status: {health.status} · v{health.version}
      </p>
    </main>
  );
}
