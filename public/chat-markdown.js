// Safe DOM-only Markdown renderer shared by chat and documentation pages.
function appendInlineMarkdown(parent, source) {
  const text = String(source || "");
  const pattern = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor)
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
    if (match[2] && match[3]) {
      const link = document.createElement("a");
      link.href = match[3];
      link.textContent = match[2];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      parent.append(link);
    } else if (match[4]) {
      const strong = document.createElement("strong");
      strong.textContent = match[4];
      parent.append(strong);
    } else {
      const code = document.createElement("code");
      code.textContent = match[5];
      parent.append(code);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function isMarkdownBlockStart(line) {
  return (
    /^```/.test(line) ||
    /^#{1,3}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*+]\s+/.test(line) ||
    /^\d+\.\s+/.test(line)
  );
}

function markdownTableCells(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map((cell) => cell.trim());
}

function isMarkdownTable(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes("|")) return false;
  const header = markdownTableCells(lines[index]);
  const divider = markdownTableCells(lines[index + 1]);
  return (
    header.length > 1 &&
    divider.length === header.length &&
    divider.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function renderMarkdown(container, source) {
  container.replaceChildren();
  const lines = String(source || "")
    .replaceAll("\r", "")
    .split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^```\s*([^\s`]*)/);
    if (fence) {
      const language = fence[1] || "code";
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      const shell = document.createElement("div");
      shell.className = "markdown-code";
      const toolbar = document.createElement("div");
      toolbar.className = "markdown-code-toolbar";
      const label = document.createElement("span");
      label.textContent = language;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "复制";
      const codeText = codeLines.join("\n");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(codeText);
          copy.textContent = "已复制";
          setTimeout(() => {
            copy.textContent = "复制";
          }, 1200);
        } catch {
          toast("复制失败，请手动选择代码", "error");
        }
      });
      toolbar.append(label, copy);
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeText;
      pre.append(code);
      shell.append(toolbar, pre);
      container.append(shell);
      continue;
    }
    if (isMarkdownTable(lines, index)) {
      const headers = markdownTableCells(lines[index]);
      const dividers = markdownTableCells(lines[index + 1]);
      index += 2;
      const wrapper = document.createElement("div");
      wrapper.className = "markdown-table-wrap";
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      headers.forEach((cell, cellIndex) => {
        const element = document.createElement("th");
        const divider = dividers[cellIndex];
        element.style.textAlign =
          divider.startsWith(":") && divider.endsWith(":")
            ? "center"
            : divider.endsWith(":")
              ? "right"
              : "left";
        appendInlineMarkdown(element, cell);
        headRow.append(element);
      });
      head.append(headRow);
      const body = document.createElement("tbody");
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const cells = markdownTableCells(lines[index++]);
        const row = document.createElement("tr");
        headers.forEach((_, cellIndex) => {
          const element = document.createElement("td");
          element.style.textAlign = headRow.children[cellIndex].style.textAlign;
          appendInlineMarkdown(element, cells[cellIndex] || "");
          row.append(element);
        });
        body.append(row);
      }
      table.append(head, body);
      wrapper.append(table);
      container.append(wrapper);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length + 2}`);
      appendInlineMarkdown(element, heading[2]);
      container.append(element);
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index]))
        quoteLines.push(lines[index++].replace(/^>\s?/, ""));
      appendInlineMarkdown(quote, quoteLines.join("\n"));
      container.append(quote);
      continue;
    }
    const unordered = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const list = document.createElement(unordered ? "ul" : "ol");
      const itemPattern = unordered ? /^[-*+]\s+(.+)$/ : /^\d+\.\s+(.+)$/;
      while (index < lines.length) {
        const itemMatch = lines[index].match(itemPattern);
        if (!itemMatch) break;
        const item = document.createElement("li");
        appendInlineMarkdown(item, itemMatch[1]);
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isMarkdownBlockStart(lines[index]) &&
      !isMarkdownTable(lines, index)
    ) {
      paragraphLines.push(lines[index++]);
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join("\n"));
    container.append(paragraph);
  }
}
