import commA from "./user-space-ruok/matrix/comm-a.txt?raw";
import commB from "./user-space-ruok/matrix/comm-b.txt?raw";
import csvData from "./user-space-ruok/matrix/data.csv?raw";
import jsonData from "./user-space-ruok/matrix/data.json?raw";
import joinA from "./user-space-ruok/matrix/join-a.txt?raw";
import joinB from "./user-space-ruok/matrix/join-b.txt?raw";
import notes from "./user-space-ruok/matrix/notes.md?raw";
import other from "./user-space-ruok/matrix/other.txt?raw";
import page from "./user-space-ruok/matrix/page.html?raw";
import text from "./user-space-ruok/matrix/text.txt?raw";
import textCopy from "./user-space-ruok/matrix/text-copy.txt?raw";

export type RuokFixtureFile = {
  path: string;
  content: string;
};

export const RUOK_FIXTURE_SOURCE_ROOT = "web/src/fixtures/user-space-ruok";

export const RUOK_FIXTURE_DIRECTORIES = ["matrix", "src"] as const;

export const RUOK_FIXTURE_FILES: RuokFixtureFile[] = [
  { path: "matrix/text.txt", content: text },
  { path: "matrix/text-copy.txt", content: textCopy },
  { path: "matrix/other.txt", content: other },
  { path: "matrix/comm-a.txt", content: commA },
  { path: "matrix/comm-b.txt", content: commB },
  { path: "matrix/join-a.txt", content: joinA },
  { path: "matrix/join-b.txt", content: joinB },
  { path: "matrix/notes.md", content: notes },
  { path: "matrix/data.json", content: jsonData },
  { path: "matrix/page.html", content: page },
  { path: "matrix/data.csv", content: csvData },
];
