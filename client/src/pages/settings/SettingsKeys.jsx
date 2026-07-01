export default function SettingsKeys({ settings }) {
  return (
    <section className="card">
      <h2>Connection (env-configured)</h2>
      <table className="kv-table">
        <tbody>
          {Object.entries(settings.env).map(([key, value]) => (
            <tr key={key}>
              <td>{key}</td>
              <td>{value || <em>not set</em>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">These are configured via environment variables on Render and are read-only here.</p>
    </section>
  );
}
