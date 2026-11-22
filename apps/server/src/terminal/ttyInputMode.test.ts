import { describe, expect, it } from "vite-plus/test";

import { inputModeFromLocalFlags, parseSttyInputMode } from "./ttyInputMode.ts";

const MACOS_STTY = `speed 9600 baud; 24 rows; 80 columns;
lflags: icanon isig iexten echo echoe -echok echoke -echonl echoctl
\t-echoprt -altwerase -noflsh -tostop -flusho pendin -nokerninfo
\t-extproc
iflags: -istrip icrnl -inlcr -igncr ixon -ixoff ixany imaxbel iutf8
\t-ignbrk brkint -inpck -ignpar -parmrk
oflags: opost onlcr -oxtabs -onocr -onlret
cflags: cread cs8 -parenb -parodd hupcl -clocal -cstopb -crtscts -dsrflow
\t-dtrflow -mdmbuf
cchars: discard = ^O; dsusp = ^Y; eof = ^D; eol = <undef>;
\teol2 = <undef>; erase = ^?; intr = ^C; kill = ^U; lnext = ^V;
\tmin = 1; quit = ^\\; reprint = ^R; start = ^Q; status = ^T;
\tstop = ^S; susp = ^Z; time = 0; werase = ^W;
`;

const LINUX_STTY = `speed 38400 baud; rows 24; columns 80; line = 0;
intr = ^C; quit = ^\\; erase = ^?; kill = ^U; eof = ^D; eol = <undef>; eol2 = <undef>; swtch = <undef>;
start = ^Q; stop = ^S; susp = ^Z; rprnt = ^R; werase = ^W; lnext = ^V; discard = ^O; min = 1; time = 0;
-parenb -parodd -cmspar cs8 -hupcl -cstopb cread -clocal -crtscts
-ignbrk -brkint -ignpar -parmrk -inpck -istrip -inlcr -igncr icrnl ixon -ixoff -iuclc -ixany -imaxbel iutf8
opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0 tab0 bs0 vt0 ff0
isig icanon iexten -echo echoe echok -echonl -noflsh -xcase -tostop -echoprt echoctl echoke -flusho -extproc
`;

describe("parseSttyInputMode", () => {
  it("reads macOS output", () => {
    expect(parseSttyInputMode(MACOS_STTY)).toEqual({ echo: true, canonical: true });
  });

  it("reads Linux output with a password prompt's flags", () => {
    expect(parseSttyInputMode(LINUX_STTY)).toEqual({ echo: false, canonical: true });
  });

  it("reads raw mode", () => {
    expect(
      parseSttyInputMode(MACOS_STTY.replace(" icanon ", " -icanon ").replace(" echo ", " -echo ")),
    ).toEqual({ echo: false, canonical: false });
  });

  it("does not take echoe or echoctl for echo", () => {
    expect(parseSttyInputMode("lflags: icanon echoe echoctl echok")).toBe(undefined);
  });

  it("returns nothing when a flag is missing", () => {
    expect(parseSttyInputMode("")).toBe(undefined);
    expect(parseSttyInputMode("lflags: icanon isig")).toBe(undefined);
    expect(parseSttyInputMode("lflags: -echo isig")).toBe(undefined);
  });
});

describe("inputModeFromLocalFlags", () => {
  const ECHO = 0o10;

  it("uses the macOS ICANON bit on darwin", () => {
    const ICANON = 0x100;
    expect(inputModeFromLocalFlags(ECHO | ICANON, "darwin")).toEqual({
      echo: true,
      canonical: true,
    });
    expect(inputModeFromLocalFlags(ICANON, "darwin")).toEqual({ echo: false, canonical: true });
    expect(inputModeFromLocalFlags(0o2, "darwin")).toEqual({ echo: false, canonical: false });
  });

  it("uses the Linux ICANON bit elsewhere", () => {
    const ICANON = 0o2;
    expect(inputModeFromLocalFlags(ECHO | ICANON, "linux")).toEqual({
      echo: true,
      canonical: true,
    });
    expect(inputModeFromLocalFlags(ICANON, "linux")).toEqual({ echo: false, canonical: true });
    expect(inputModeFromLocalFlags(0x100, "linux")).toEqual({ echo: false, canonical: false });
  });

  it("returns nothing for a value that is not an integer", () => {
    expect(inputModeFromLocalFlags(Number.NaN, "linux")).toBe(undefined);
    expect(inputModeFromLocalFlags(1.5, "darwin")).toBe(undefined);
  });
});
