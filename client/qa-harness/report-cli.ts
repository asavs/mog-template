/**
 * CLI entry for report generation (`npm run qa:report`). Separate from
 * report.ts because vite-node strips the script path from process.argv,
 * making "am I the entry module?" undetectable — a dedicated entry file
 * needs no detection.
 */
import { runReportCli } from './report';

runReportCli();
