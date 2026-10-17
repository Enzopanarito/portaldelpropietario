# Regional Platform Web

This is the commercial web/runtime shell for the regional community platform.

It is intentionally separate from the legacy VLA Netlify application. The intended deployment target is a dedicated company/JV Vercel team, not the existing personal Hobby team.

## Runtime model

One Vercel application serves many communities. It resolves each tenant through a future company-owned Control Plane and connects the tenant to its dedicated Supabase Data Plane. Do not create a Vercel project per condominium.

## Local development

```bash
npm install
npm test
npm run build
npm run dev
```

Copy `.env.example` to a local ignored environment file only when runtime integration requires it. Never commit real credentials.

## Environment rules

- `NEXT_PUBLIC_*` may contain only values safe for browsers.
- Secret/service-role keys are server-only.
- No Netlify function, Blob, redirect or Edge Function is part of this app contract.
- Git is source-of-truth for code; Supabase migrations are source-of-truth for database evolution.
