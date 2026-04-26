export default function Onboarding() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        marginTop: "50px",
      }}
    >
      <img
        src="https://upload.wikimedia.org/wikipedia/commons/a/a7/React-icon.svg"
        alt="React Logo"
        style={{ width: "200px", marginBottom: "20px" }}
      />
      <h1>Onboarding</h1>
      <p>Welcome to your React App inside Electron!</p>
    </div>
  );
}
