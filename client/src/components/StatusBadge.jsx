const COLORS = {
  published: "#1a7f37",
  draft: "#9a6700",
  missing: "#6e7781",
};

const LABELS = {
  published: "Translated",
  draft: "Pending",
  missing: "Missing",
};

export default function StatusBadge({ status }) {
  return (
    <span className="status-badge" style={{ backgroundColor: COLORS[status] || "#6e7781" }}>
      {LABELS[status] || status}
    </span>
  );
}
