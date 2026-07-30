# Học từ Tabby

[Tabby](https://github.com/Eugeny/tabby) (MIT, Electron + Angular) là terminal /
SSH client mã nguồn mở trưởng thành nhất trong cùng hạng mục. Bản clone của nó
nằm ở `docs/tabby` (đã cho vào `.gitignore`) và được index bằng GitNexus để tra
cứu bằng đồ thị lời gọi thay vì grep.

**Về license:** Tabby là MIT. Tài liệu này ghi lại *ý tưởng thiết kế*, không
copy code — Shellmux viết bằng Rust nên không có dòng nào bê nguyên. Nếu sau này
có port code thật từ Tabby thì phải giữ nguyên copyright notice của họ.

## Đã áp dụng

| Ý tưởng của Tabby | Nguồn trong repo Tabby | Bản Shellmux |
| --- | --- | --- |
| Import `~/.ssh/config`, id host dẫn xuất từ alias nên import lại là cập nhật | `tabby-electron/src/sshImporters.ts` | `src-tauri/src/sshconfig/` |
| Dynamic forward chạy SOCKS5 rồi mở channel theo đích client khai | `tabby-ssh/src/session/forwards.ts` | `src-tauri/src/socks.rs` + `tunnel.rs` |
| Reconnect tại chỗ, "nhấn phím bất kỳ để kết nối lại" | `tabby-terminal/src/api/connectableTerminalTab.component.ts` | `session_reconnect` + `TerminalView` |

Ba điểm đáng ghi lại vì chúng không hiển nhiên:

1. **Thứ tự trong `ssh_config` là "giá trị đầu tiên thắng"**, không phải cuối
   cùng. `Host *` đặt ở đầu file sẽ đè mọi khối phía dưới — đó là lý do
   `ssh_config(5)` bảo để nó ở cuối. Parser của Shellmux theo đúng ngữ nghĩa
   này và có test riêng cho nó.
2. **Chỉ trả lời SOCKS "thành công" sau khi channel SSH đã mở được.** Trả lời
   sớm thì client tưởng đã kết nối trong khi phía kia có thể từ chối.
3. **Reconnect phải giữ nguyên session id.** Tabby thay session bên dưới mà
   không dựng lại frontend, nhờ đó scrollback còn nguyên. Shellmux làm tương tự
   và thêm `generation` để event `closed` đến muộn của lần kết nối trước không
   đánh dấu nhầm session vừa sống lại.

## Chưa áp dụng — xếp theo giá trị

### 1. Multiplex connection giữa nhiều tab (giá trị cao)

`tabby-ssh/src/services/sshMultiplexer.service.ts` gom session theo khoá
`host:port:user:proxy` **cộng với khoá của cả chuỗi jump**. Mở 5 tab tới cùng
một VPS thì chỉ tốn một TCP và một handshake.

Shellmux hiện mở một connection cho mỗi session. Kiến trúc đã sẵn sàng (một
connection mang nhiều channel), việc còn lại là:

- pool `DashMap<MultiplexKey, Weak<SshLink>>` trong `SessionManager`
- đếm tham chiếu: chỉ `disconnect()` khi pane cuối cùng dùng link đó đóng
- khoá phải bao gồm chuỗi jump, nếu không hai host khác bastion sẽ dùng nhầm nhau

Rủi ro cần xử lý: một session rớt thì các session dùng chung phải cùng biết.

### 2. Login script / auto-sudo

`tabby-auto-sudo-password` và input script của Tabby: chờ một pattern trong
output rồi gửi chuỗi trả lời. Cực hữu ích cho `sudo` và banner đăng nhập.
Với Shellmux thì đây là một bộ quy tắc `(regex, phản hồi)` chạy trong pump ở
`session/shell.rs`.

### 3. Khôi phục tab sau khi khởi động lại

`tabby-core/src/services/tabRecovery.service.ts` lưu "recovery token" cho từng
tab rồi dựng lại toàn bộ layout khi mở app. Shellmux mất sạch tab khi đóng app.

### 4. Keyboard-interactive có giao diện riêng

`tabby-ssh/src/components/keyboardInteractiveAuthPanel.component.ts` hiện đúng
prompt của server (kể cả OTP/2FA). Shellmux đang tự trả lời mọi prompt bằng
password đã lưu — sai với server bật 2FA.

### 5. Nested split

Tabby cho tách pane lồng nhau tuỳ ý; Shellmux mới có một cấp.

### 6. Hệ thống hotkey

`tabby-core/src/services/hotkeys.service.ts` — phím tắt cấu hình được cho mọi
hành động. Shellmux mới có ⌘F.

### 7. Transport ngoài SSH

`tabby-serial`, `tabby-telnet` cho thấy cách trừu tượng hoá transport để thêm
serial/telnet mà không đụng tầng terminal. Đáng tham khảo trước khi thêm
Docker/Kubernetes exec ở Phase 3.

## Cách tra cứu lại

```bash
npx gitnexus analyze   # nếu index báo cũ
```

Rồi dùng MCP: `query({query: "...", repo: "tabby"})` để tìm luồng thực thi,
`context({name: "SymbolName", repo: "tabby"})` để xem ai gọi ai.
