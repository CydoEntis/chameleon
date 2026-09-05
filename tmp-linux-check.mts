Object.defineProperty(process, "platform", { value: "linux" });
const { runDoctorChecks } = await import("./src/index.js");
const report = runDoctorChecks();
console.log(JSON.stringify(report.targets, null, 2));
