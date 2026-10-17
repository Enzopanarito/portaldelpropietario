import { getRuntimeSummary } from '../lib/runtime';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const runtime = getRuntimeSummary();
  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '72px 28px' }}>
      <p style={{ textTransform: 'uppercase', letterSpacing: 1.2, fontSize: 12 }}>Regional Community Platform</p>
      <h1 style={{ fontSize: 42, lineHeight: 1.05, margin: '16px 0' }}>Núcleo comercial en desarrollo</h1>
      <p style={{ fontSize: 18, lineHeight: 1.6, maxWidth: 720 }}>
        Aplicación regional independiente del portal VLA. Cada comunidad podrá operar sobre un Data Plane Supabase dedicado,
        mientras esta aplicación resuelve identidad, navegación, configuración y orquestación regional.
      </p>
      <section style={{ marginTop: 40, padding: 24, background: '#fff', borderRadius: 16 }}>
        <strong>Estado técnico</strong>
        <ul style={{ lineHeight: 1.8 }}>
          <li>Hosting objetivo: {runtime.hostingTarget}</li>
          <li>Routing: {runtime.tenantRoutingMode}</li>
          <li>Aislamiento: {runtime.dataPlaneIsolation}</li>
          <li>Entorno: {runtime.platformEnvironment}</li>
        </ul>
      </section>
    </main>
  );
}
