import com.android.ide.common.vectordrawable.Svg2Vector;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Converts SVG files with Android Studio's importer (Svg2Vector) in a single JVM.
 *
 * Usage: Svg2VectorRunner <jobs.tsv> <results.jsonl>
 *   jobs.tsv: one job per line, "<source.svg>\t<destination.xml>".
 *   results.jsonl: one JSON object per job, in order:
 *     {"src", "ok", "ms", "bytes", "messages", "exception"}
 *   "messages" is the error/warning log returned by parseSvgToXml (empty when clean); "ok" is false
 *   when it threw or wrote nothing. The XML is written only when non-empty.
 */
public final class Svg2VectorRunner {
    public static void main(String[] args) throws IOException {
        if (args.length != 2) {
            System.err.println("usage: Svg2VectorRunner <jobs.tsv> <results.jsonl>");
            System.exit(2);
        }
        List<String> lines = Files.readAllLines(Path.of(args[0]), StandardCharsets.UTF_8);
        try (PrintStream out = new PrintStream(Files.newOutputStream(Path.of(args[1])), true, StandardCharsets.UTF_8)) {
            for (String line : lines) {
                if (line.isBlank()) continue;
                String[] parts = line.split("\t", 2);
                out.println(convert(Path.of(parts[0]), Path.of(parts[1])));
            }
        }
    }

    private static String convert(Path src, Path dest) {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        String messages = "";
        String exception = null;
        long start = System.nanoTime();
        try {
            String log = Svg2Vector.parseSvgToXml(src, buffer);
            if (log != null) messages = log;
        } catch (Throwable t) {
            exception = t.getClass().getName() + ": " + t.getMessage();
        }
        double ms = (System.nanoTime() - start) / 1e6;
        byte[] xml = buffer.toByteArray();
        if (xml.length > 0) {
            try {
                Files.createDirectories(dest.getParent());
                Files.write(dest, xml);
            } catch (IOException e) {
                exception = "write failed: " + e.getMessage();
            }
        }
        boolean ok = exception == null && xml.length > 0;
        return "{\"src\":" + json(src.toString()) + ",\"ok\":" + ok + ",\"ms\":" + ms
                + ",\"bytes\":" + xml.length + ",\"messages\":" + json(messages.trim())
                + ",\"exception\":" + (exception == null ? "null" : json(exception)) + "}";
    }

    private static String json(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.append('"').toString();
    }
}
