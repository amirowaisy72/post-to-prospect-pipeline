import sqlite3

c = sqlite3.connect("leadhunter.db")
c.execute("delete from chat_messages where role='candidate'")
c.execute("update chat_threads set last_seen_text=''")
c.commit()
print("done")
