import { createFileRoute } from "@tanstack/react-router";
import { DownloadPage } from "@/pages/DownloadPage";

export const Route = createFileRoute("/download")({ component: DownloadPage });
