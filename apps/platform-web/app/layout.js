export const metadata = {
  title: 'Regional Community Platform',
  description: 'Regional community administration and access platform'
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f7f7f7', color: '#111' }}>
        {children}
      </body>
    </html>
  );
}
