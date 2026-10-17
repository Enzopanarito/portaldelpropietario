import { NextResponse } from 'next/server';
import { assertNoPublicSecretEnv, getRuntimeSummary } from '../../../lib/runtime';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertNoPublicSecretEnv();
    return NextResponse.json({ ok: true, runtime: getRuntimeSummary() }, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      code: error?.code || 'RUNTIME_HEALTH_FAILED'
    }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' }
    });
  }
}
