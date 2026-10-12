/**
 * Копирует текст в буфер обмена. Если Clipboard API недоступен (бывает в
 * WebKitGTK вне защищённого контекста), копирует по-старому — через
 * выделенное скрытое поле.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Падаем на запасной путь ниже.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}
