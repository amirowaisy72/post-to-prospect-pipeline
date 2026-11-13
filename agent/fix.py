import sqlite3

c = sqlite3.connect("leadhunter.db")
c.execute("""update chat_messages set delivery='sent'
 where role='agent' and delivery='failed' and thread_id in
 (select id from chat_threads where profile_name like 'Rashid%')""")
c.execute(
    "delete from chat_messages where role='candidate' and (text like 'Unread message:%' or text like 'Messages and calls are secured%')"
)
c.commit()
print("done")
