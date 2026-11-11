import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings moved to the Configurations page; keep the old address working.
export const Route = createFileRoute("/settings")({
  beforeLoad: () => {
    throw redirect({ to: "/configurations", statusCode: 301 });
  },
});
